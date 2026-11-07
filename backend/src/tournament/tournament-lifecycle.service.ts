import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { TournamentHttpError } from './http/tournament.errors';
import { TournamentBracketService } from './tournament-bracket.service';
import { CloseOutcome, CloseReason, TournamentEventsPublisher } from './tournament-events.publisher';

export type { CloseOutcome, CloseReason } from './tournament-events.publisher';

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
        ? await tx.$queryRaw<{ current_participants: number }[]>`
            UPDATE tournaments SET status = 'REGISTRATION_CLOSED', updated_at = now()
            WHERE id = ${tournamentId}::uuid AND status = 'OPEN_FOR_SIGNUP'
              AND registration_deadline <= now()
            RETURNING current_participants`
        : await tx.$queryRaw<{ current_participants: number }[]>`
            UPDATE tournaments SET status = 'REGISTRATION_CLOSED', updated_at = now()
            WHERE id = ${tournamentId}::uuid AND status = 'OPEN_FOR_SIGNUP'
            RETURNING current_participants`;
      if (rows.length === 0) {
        const exists = await tx.tournament.count({ where: { id: tournamentId } });
        if (!exists) throw new TournamentHttpError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found.');
        throw new TournamentHttpError(409, 'REGISTRATION_CLOSED', 'Registration is already closed.');
      }

      // Counter read from the locked row; join/leave keep it equal to the participant rows.
      if (rows[0].current_participants < 2) {
        await tx.tournament.update({ where: { id: tournamentId }, data: { status: 'CANCELLED' } });
        return 'CANCELLED' as const;
      }
      await this.bracket.generateAndSaveBracket(tx, tournamentId);
      return 'IN_PROGRESS' as const;
    });

    this.logger.log(`Tournament ${tournamentId} closed (${reason}): ${outcome}`);
    this.events.registrationClosed({ tournamentId, outcome, reason, at: new Date() });
    return outcome;
  }
}
