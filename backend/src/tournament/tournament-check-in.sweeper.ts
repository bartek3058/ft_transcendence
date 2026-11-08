import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { TournamentBracketService } from './tournament-bracket.service';
import { TournamentGameCreated, TournamentGameService } from './tournament-game.service';

export const CHECK_IN_SWEEP_INTERVAL_MS = 10_000;
/** Consecutive failures after which a match is no longer retried (needs a manual fix). */
export const MAX_SWEEP_ATTEMPTS = 5;

export type SweepAction = 'STARTED' | 'WALKOVER' | 'DOUBLE_FORFEIT' | 'ALREADY_RESOLVED';

export interface SweepTickResult {
  skipped: boolean;
  started: number;
  walkovers: number;
  doubleForfeits: number;
  alreadyResolved: number;
  failed: number;
  quarantined: number;
}

type LockedMatch = {
  player1_id: string;
  player2_id: string;
  player1_checked_in_at: Date | null;
  player2_checked_in_at: Date | null;
}[];

/**
 * Resolves SCHEDULED matches whose check-in deadline has passed (#161):
 * one player checked in -> walkover for the absent one; nobody -> double forfeit;
 * both but no game (only possible for older data) -> start the game.
 *
 * State lives in the DB, so a restart loses nothing. Each match runs in its own
 * transaction and is locked (FOR UPDATE) while it is still expired and SCHEDULED; a
 * check-in that won the race simply makes the row disappear from that SELECT.
 * Any error after the lock therefore means inconsistent data: it is counted, and after
 * MAX_SWEEP_ATTEMPTS failures in a row the match is no longer retried and is reported
 * for a manual fix. Nobody is forfeited because of a data problem. The count and the
 * skip list are in memory; a restart clears them.
 */
@Injectable()
export class TournamentCheckInSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TournamentCheckInSweeper.name);
  private readonly failures = new Map<string, number>();
  private readonly quarantined = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private isExecuting = false;

  constructor(private readonly prisma: PrismaService,
    private readonly bracket: TournamentBracketService,
    private readonly games: TournamentGameService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.tick(); }, CHECK_IN_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<SweepTickResult> {
    const result: SweepTickResult = {
      skipped: false, started: 0, walkovers: 0, doubleForfeits: 0, alreadyResolved: 0, failed: 0, quarantined: 0,
    };
    if (this.isExecuting) return { ...result, skipped: true };
    this.isExecuting = true;
    try {
      // Only matches that can be resolved: both players known, no winner yet, live tournament.
      const due = await this.prisma.tournamentMatch.findMany({
        where: {
          status: 'SCHEDULED',
          checkInDeadline: { lte: new Date() },
          player1Id: { not: null },
          player2Id: { not: null },
          winnerId: null,
          tournament: { status: 'IN_PROGRESS' },
        },
        orderBy: [{ checkInDeadline: 'asc' }, { id: 'asc' }],
        select: { id: true, tournamentId: true },
      });
      for (const match of due) {
        if (this.quarantined.has(match.id)) continue;
        await this.handle(match.tournamentId, match.id, result);
      }
    } catch (error) {
      this.logger.error(`Check-in sweep scan failed: ${describe(error)}`);
    } finally {
      this.isExecuting = false;
    }
    result.quarantined = this.quarantined.size;
    return result;
  }

  /** One match; never throws, so a failure cannot stop the rest of the tick. */
  private async handle(tournamentId: string, matchId: string, result: SweepTickResult): Promise<void> {
    try {
      const action = await this.resolve(tournamentId, matchId);
      this.failures.delete(matchId);
      if (action === 'STARTED') result.started++;
      else if (action === 'WALKOVER') result.walkovers++;
      else if (action === 'DOUBLE_FORFEIT') result.doubleForfeits++;
      else result.alreadyResolved++;
    } catch (error) {
      result.failed++;
      const attempts = (this.failures.get(matchId) ?? 0) + 1;
      this.failures.set(matchId, attempts);
      this.logger.error(`Match ${matchId} (tournament ${tournamentId}) could not be resolved ` +
        `(attempt ${attempts}/${MAX_SWEEP_ATTEMPTS}): ${describe(error)}`);
      if (attempts >= MAX_SWEEP_ATTEMPTS) {
        this.failures.delete(matchId);
        this.quarantined.add(matchId);
        this.logger.error(`Match ${matchId} (tournament ${tournamentId}) is no longer retried: ` +
          'its data is inconsistent and needs a manual fix.');
      }
    }
  }

  async resolve(tournamentId: string, matchId: string): Promise<SweepAction> {
    let created = null as TournamentGameCreated | null; // `as`: assigned inside the transaction callback
    const action = await this.prisma.$transaction(async (tx): Promise<SweepAction> => {
      const rows = await tx.$queryRaw<LockedMatch>`
        SELECT player1_id, player2_id, player1_checked_in_at, player2_checked_in_at
        FROM tournament_matches
        WHERE id = ${matchId}::uuid AND status = 'SCHEDULED' AND check_in_deadline <= now()
          AND winner_id IS NULL AND player1_id IS NOT NULL AND player2_id IS NOT NULL
        FOR UPDATE`;
      if (rows.length === 0) return 'ALREADY_RESOLVED'; // a check-in or another sweep won
      const m = rows[0];
      const p1 = m.player1_checked_in_at !== null;
      const p2 = m.player2_checked_in_at !== null;
      if (p1 && p2) {
        created = await this.games.createMatchGame(tx, tournamentId, matchId);
        return 'STARTED';
      }
      if (p1 || p2) {
        await this.bracket.handleWalkover(tx, tournamentId, matchId, p1 ? m.player2_id : m.player1_id);
        return 'WALKOVER';
      }
      await this.bracket.handleDoubleForfeit(tx, tournamentId, matchId);
      return 'DOUBLE_FORFEIT';
    });
    if (created) this.games.startSession(created);
    if (action !== 'ALREADY_RESOLVED') this.logger.log(`Match ${matchId}: check-in deadline passed -> ${action}`);
    return action;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
