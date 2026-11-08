import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TournamentHttpError } from './http/tournament.errors';
import { TournamentBracketService } from './tournament-bracket.service';
import { CloseOutcome, CloseReason, TournamentEventsPublisher } from './tournament-events.publisher';

export type { CloseOutcome, CloseReason } from './tournament-events.publisher';

type Locked = { current_participants: number }[];

/**
 * Registration close -> bracket start, in one transaction.
 *
 * The conditional status UPDATE (OPEN_FOR_SIGNUP -> REGISTRATION_CLOSED) locks the
 * tournament row: racing joins/leaves wait for it and then fail their status check,
 * and a concurrent close or scheduler run matches 0 rows, so the bracket is generated
 * exactly once. The event is published only after the commit.
 */
@Injectable()
export class TournamentLifecycleService {
  private readonly logger = new Logger(TournamentLifecycleService.name);

  constructor(private readonly prisma: PrismaService,
    private readonly bracket: TournamentBracketService,
    private readonly events: TournamentEventsPublisher) {}

  async closeAndStart(tournamentId: string, reason: CloseReason): Promise<CloseOutcome> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      // The scheduler closes only expired registrations; the creator/admin may close early.
      const rows = reason === 'SCHEDULER'
        ? await tx.$queryRaw<Locked>`
            UPDATE tournaments SET status = 'REGISTRATION_CLOSED', updated_at = now()
            WHERE id = ${tournamentId}::uuid AND status = 'OPEN_FOR_SIGNUP'
              AND registration_deadline <= now()
            RETURNING current_participants`
        : await tx.$queryRaw<Locked>`
            UPDATE tournaments SET status = 'REGISTRATION_CLOSED', updated_at = now()
            WHERE id = ${tournamentId}::uuid AND status = 'OPEN_FOR_SIGNUP'
            RETURNING current_participants`;
      if (rows.length === 0) throw await this.rejection(tx, tournamentId);
      return this.startOrCancel(tx, tournamentId, rows[0].current_participants);
    });
    this.finish(tournamentId, reason, outcome);
    return outcome;
  }

  /**
   * Recovery for a tournament left in REGISTRATION_CLOSED (closeAndStart commits only
   * IN_PROGRESS or CANCELLED, so this state is never an in-flight close). Row-locked,
   * so a concurrent retry or cancel gets 409.
   */
  async startClosed(tournamentId: string): Promise<CloseOutcome> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Locked>`
        SELECT current_participants FROM tournaments
        WHERE id = ${tournamentId}::uuid AND status = 'REGISTRATION_CLOSED'
        FOR UPDATE`;
      if (rows.length === 0) throw await this.rejection(tx, tournamentId);
      return this.startOrCancel(tx, tournamentId, rows[0].current_participants);
    });
    this.finish(tournamentId, 'SCHEDULER', outcome);
    return outcome;
  }

  /**
   * Manual cancel (permission is checked by the caller). Allowed only from
   * OPEN_FOR_SIGNUP / REGISTRATION_CLOSED; IN_PROGRESS is out of scope (live games).
   * The conditional UPDATE takes the same row lock as join, leave, close and the
   * scheduler, so any race ends in exactly one committed outcome.
   */
  async cancel(tournamentId: string): Promise<void> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE tournaments SET status = 'CANCELLED', updated_at = now()
      WHERE id = ${tournamentId}::uuid AND status IN ('OPEN_FOR_SIGNUP', 'REGISTRATION_CLOSED')
      RETURNING id`;
    if (rows.length === 0) {
      const exists = await this.prisma.tournament.count({ where: { id: tournamentId } });
      if (!exists) throw new TournamentHttpError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found.');
      throw new TournamentHttpError(409, 'TOURNAMENT_NOT_CANCELLABLE',
        'Only a tournament that has not started can be cancelled.');
    }
    this.logger.log(`Tournament ${tournamentId} cancelled (MANUAL).`);
    this.events.cancelled({ tournamentId, at: new Date() });
  }

  /**
   * Gives up on a tournament whose bracket start keeps failing: CANCELLED, only if it is
   * still expired-open or REGISTRATION_CLOSED (never one that started meanwhile).
   * Returns false when the tournament was already handled elsewhere.
   */
  async cancelUnstartable(tournamentId: string): Promise<boolean> {
    const cancelled = await this.prisma.tournament.updateMany({
      where: {
        id: tournamentId,
        OR: [
          { status: 'OPEN_FOR_SIGNUP', registrationDeadline: { lte: new Date() } },
          { status: 'REGISTRATION_CLOSED' },
        ],
      },
      data: { status: 'CANCELLED' },
    });
    if (cancelled.count !== 1) return false;
    this.logger.warn(`Tournament ${tournamentId} cancelled: bracket start kept failing.`);
    this.events.registrationClosed({ tournamentId, outcome: 'CANCELLED', reason: 'SCHEDULER', at: new Date() });
    return true;
  }

  /** Counter read from the locked row; join/leave keep it equal to the participant rows. */
  private async startOrCancel(tx: Prisma.TransactionClient, tournamentId: string,
    participants: number): Promise<CloseOutcome> {
    if (participants < 2) {
      await tx.tournament.update({ where: { id: tournamentId }, data: { status: 'CANCELLED' } });
      return 'CANCELLED';
    }
    await this.bracket.generateAndSaveBracket(tx, tournamentId);
    return 'IN_PROGRESS';
  }

  private async rejection(tx: Prisma.TransactionClient, tournamentId: string) {
    const exists = await tx.tournament.count({ where: { id: tournamentId } });
    if (!exists) return new TournamentHttpError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found.');
    return new TournamentHttpError(409, 'REGISTRATION_CLOSED', 'Registration is already closed.');
  }

  private finish(tournamentId: string, reason: CloseReason, outcome: CloseOutcome): void {
    this.logger.log(`Tournament ${tournamentId} closed (${reason}): ${outcome}`);
    this.events.registrationClosed({ tournamentId, outcome, reason, at: new Date() });
  }
}
