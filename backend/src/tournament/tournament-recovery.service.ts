import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { GameOverReason, SERVER_RESTART_REASON } from '../game/types/chess.types';
import { TournamentEventsPublisher } from './tournament-events.publisher';
import { TournamentGameService } from './tournament-game.service';
import { TOURNAMENT_CHECK_IN_WINDOW_MS } from './tournament-rules';

export const RECOVERY_INTERVAL_MS = 30_000;
// give the normal conclusion listener this long first
export const RECOVERY_GRACE_MS = 30_000;
// after this many failures in a row it needs a manual fix
export const MAX_RECOVERY_ATTEMPTS = 5;
export { SERVER_RESTART_REASON };

export type RecoveryAction = 'REAPPLIED' | 'REOPENED' | 'ALREADY_RESOLVED';

export interface RecoveryTickResult {
  skipped: boolean;
  reapplied: number;
  reopened: number;
  alreadyResolved: number;
  failed: number;
  quarantined: number;
}

export interface StuckMatch {
  match_id: string;
  tournament_id: string;
  game_id: string;
  result: 'WHITE_WON' | 'BLACK_WON' | 'DRAW' | 'ABORTED';
  end_reason: string | null;
  white_id: string | null;
  black_id: string | null;
}

// Fixes tournament matches stuck IN_PROGRESS (#168). On startup, games lost by a restart
// are aborted. Every 30 s, finished games get their result applied again and aborted
// ones send the match back to check-in. Assumes a single backend instance.
@Injectable()
export class TournamentRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TournamentRecoveryService.name);
  private readonly failures = new Map<string, number>();
  private readonly quarantined = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private isExecuting = false;

  constructor(private readonly prisma: PrismaService,
    private readonly games: TournamentGameService,
    private readonly events: TournamentEventsPublisher) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.abortOrphanedGames();
    } catch (error) {
      // nothing else will fix an orphaned game, so log it and keep booting
      this.logger.error(`Could not abort orphaned tournament games: ${describe(error)}`);
    }
    this.timer = setInterval(() => { void this.tick(); }, RECOVERY_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // startup only, no session can be in memory yet
  async abortOrphanedGames(): Promise<number> {
    const { count } = await this.prisma.game.updateMany({
      where: { tournamentMatchId: { not: null }, result: 'IN_PROGRESS' },
      data: { result: 'ABORTED', endReason: SERVER_RESTART_REASON, gameEnd: new Date() },
    });
    if (count) this.logger.warn(`Aborted ${count} tournament game(s) interrupted by a restart.`);
    return count;
  }

  async tick(): Promise<RecoveryTickResult> {
    const result: RecoveryTickResult = {
      skipped: false, reapplied: 0, reopened: 0, alreadyResolved: 0, failed: 0, quarantined: 0,
    };
    if (this.isExecuting) return { ...result, skipped: true };
    this.isExecuting = true;
    try {
      for (const stuck of await this.findStuck()) {
        if (this.quarantined.has(stuck.match_id)) continue;
        try {
          const action = await this.recover(stuck);
          this.failures.delete(stuck.match_id);
          if (action === 'REAPPLIED') result.reapplied++;
          else if (action === 'REOPENED') result.reopened++;
          else result.alreadyResolved++;
        } catch (error) {
          result.failed++;
          this.countFailure(stuck, error);
        }
      }
    } catch (error) {
      this.logger.error(`Recovery scan failed: ${describe(error)}`);
    } finally {
      this.isExecuting = false;
    }
    result.quarantined = this.quarantined.size;
    return result;
  }

  async findStuck(now = new Date()): Promise<StuckMatch[]> {
    const before = new Date(now.getTime() - RECOVERY_GRACE_MS);
    return this.prisma.$queryRaw<StuckMatch[]>`
      SELECT m.id AS match_id, m.tournament_id, g.id AS game_id, g.result, g.end_reason, g.white_id, g.black_id
      FROM tournament_matches m
      JOIN tournaments t ON t.id = m.tournament_id AND t.status = 'IN_PROGRESS'
      JOIN LATERAL (
        SELECT id, result, end_reason, white_id, black_id, game_start, game_end
        FROM games WHERE tournament_match_id = m.id
        ORDER BY game_start DESC, id DESC LIMIT 1
      ) g ON true
      WHERE m.status = 'IN_PROGRESS'
        AND g.result <> 'IN_PROGRESS'
        AND NOT EXISTS (SELECT 1 FROM games l WHERE l.tournament_match_id = m.id AND l.result = 'IN_PROGRESS')
        AND COALESCE(g.game_end, g.game_start) <= ${before}
      ORDER BY m.id`;
  }

  async recover(stuck: StuckMatch): Promise<RecoveryAction> {
    if (stuck.result === 'ABORTED') return this.reopenCheckIn(stuck);
    if (!stuck.white_id || !stuck.black_id) {
      throw new Error(`Game ${stuck.game_id} has no player ids; cannot re-apply its result.`);
    }
    // a ConflictException means the result is already in, only counts if it repeats
    await this.games.applyGameResult(stuck.tournament_id, stuck.match_id, {
      gameId: stuck.game_id,
      result: stuck.result,
      endReason: stuck.end_reason as GameOverReason | null,
      whitePlayerId: stuck.white_id,
      blackPlayerId: stuck.black_id,
    });
    this.logger.warn(`Match ${stuck.match_id}: re-applied the result of game ${stuck.game_id}.`);
    return 'REAPPLIED';
  }

  private async reopenCheckIn(stuck: StuckMatch): Promise<RecoveryAction> {
    const deadline = new Date(Date.now() + TOURNAMENT_CHECK_IN_WINDOW_MS);
    const updated = await this.prisma.$executeRaw`
      UPDATE tournament_matches
      SET status = 'SCHEDULED', check_in_deadline = ${deadline},
          player1_checked_in_at = NULL, player2_checked_in_at = NULL
      WHERE id = ${stuck.match_id}::uuid AND status = 'IN_PROGRESS' AND winner_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM games WHERE tournament_match_id = ${stuck.match_id}::uuid AND result = 'IN_PROGRESS')`;
    if (updated !== 1) return 'ALREADY_RESOLVED';
    this.logger.warn(`Match ${stuck.match_id}: game ${stuck.game_id} was aborted; check-in reopened.`);
    this.events.bracketChanged(stuck.tournament_id, [stuck.match_id], false);
    return 'REOPENED';
  }

  private countFailure(stuck: StuckMatch, error: unknown): void {
    const attempts = (this.failures.get(stuck.match_id) ?? 0) + 1;
    this.failures.set(stuck.match_id, attempts);
    this.logger.error(`Match ${stuck.match_id} (tournament ${stuck.tournament_id}) could not be recovered ` +
      `(attempt ${attempts}/${MAX_RECOVERY_ATTEMPTS}): ${describe(error)}`);
    if (attempts >= MAX_RECOVERY_ATTEMPTS) {
      this.failures.delete(stuck.match_id);
      this.quarantined.add(stuck.match_id);
      this.logger.error(`Match ${stuck.match_id} (tournament ${stuck.tournament_id}) is no longer retried: ` +
        'its data is inconsistent and needs a manual fix.');
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
