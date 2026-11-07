import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { TournamentHttpError } from './http/tournament.errors';
import { TournamentBracketService } from './tournament-bracket.service';

export type CloseSource = 'MANUAL' | 'SCHEDULER';
export type CloseOutcome = 'IN_PROGRESS' | 'CANCELLED';

/**
 * Registration close -> bracket start, in one transaction.
 *
 * The conditional status update (OPEN_FOR_SIGNUP -> REGISTRATION_CLOSED) locks the
 * tournament row, so join/leave wait for it and a concurrent close or scheduler run
 * gets 0 rows: the bracket is generated exactly once.
 */
@Injectable()
export class TournamentLifecycleService {
  private readonly logger = new Logger(TournamentLifecycleService.name);

  constructor(private readonly prisma: PrismaService,
    private readonly bracket: TournamentBracketService) {}

  async closeAndStart(tournamentId: string, source: CloseSource): Promise<CloseOutcome> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.tournament.updateMany({
        where: {
          id: tournamentId,
          status: 'OPEN_FOR_SIGNUP',
          // The scheduler closes only expired registrations; the creator/admin may close early.
          ...(source === 'SCHEDULER' ? { registrationDeadline: { lte: new Date() } } : {}),
        },
        data: { status: 'REGISTRATION_CLOSED' },
      });
      if (claimed.count !== 1) {
        const exists = await tx.tournament.count({ where: { id: tournamentId } });
        if (!exists) throw new TournamentHttpError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found.');
        throw new TournamentHttpError(409, 'REGISTRATION_CLOSED', 'Registration is already closed.');
      }

      const participants = await tx.tournamentParticipant.count({ where: { tournamentId } });
      if (participants < 2) {
        await tx.tournament.update({ where: { id: tournamentId }, data: { status: 'CANCELLED' } });
        return 'CANCELLED' as const;
      }
      await this.bracket.generateAndSaveBracket(tx, tournamentId);
      return 'IN_PROGRESS' as const;
    });
    this.logger.log(`Tournament ${tournamentId} closed (${source}): ${outcome}`);
    return outcome;
  }
}
