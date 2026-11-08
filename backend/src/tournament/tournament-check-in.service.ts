import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TournamentHttpError } from './http/tournament.errors';
import { TournamentGameCreated, TournamentGameService } from './tournament-game.service';
import { TournamentMatchStatus } from './types/tournament.types';

export interface CheckInState {
  matchId: string;
  status: TournamentMatchStatus;
  checkInDeadline: Date | null;
  player1CheckedIn: boolean;
  player2CheckedIn: boolean;
  /** Live game of the match (or the last one played); null until the game starts. */
  gameId: string | null;
}

type CheckedIn = { player1_checked_in_at: Date | null; player2_checked_in_at: Date | null }[];

/**
 * Match check-in (#161). The caller is always the session user. The conditional
 * UPDATE (still SCHEDULED, before the deadline, not yet checked in) locks the match
 * row, so a check-in cannot race the deadline sweep or the other player's check-in:
 * exactly one transaction sees both players checked in and creates the game.
 */
@Injectable()
export class TournamentCheckInService {
  constructor(private readonly prisma: PrismaService,
    private readonly games: TournamentGameService) {}

  async checkIn(userId: string, tournamentId: string, matchId: string): Promise<CheckInState> {
    let created = null as TournamentGameCreated | null; // `as`: assigned inside the transaction callback
    const state = await this.prisma.$transaction(async (tx) => {
      const match = await tx.tournamentMatch.findUnique({
        where: { id: matchId },
        select: { tournamentId: true, player1Id: true, player2Id: true, tournament: { select: { status: true } } },
      });
      if (!match || match.tournamentId !== tournamentId) {
        throw new TournamentHttpError(404, 'MATCH_NOT_FOUND', 'Match not found in this tournament.');
      }
      const slot = match.player1Id === userId ? 'player1' : match.player2Id === userId ? 'player2' : null;
      if (!slot) throw new TournamentHttpError(403, 'NOT_MATCH_PLAYER', 'You are not a player in this match.');
      if (match.tournament.status !== 'IN_PROGRESS') {
        throw new TournamentHttpError(409, 'TOURNAMENT_NOT_IN_PROGRESS', 'The tournament is not in progress.');
      }

      const rows = slot === 'player1'
        ? await tx.$queryRaw<CheckedIn>`
            UPDATE tournament_matches SET player1_checked_in_at = now()
            WHERE id = ${matchId}::uuid AND player1_id = ${userId}::uuid AND status = 'SCHEDULED'
              AND check_in_deadline > now() AND player1_checked_in_at IS NULL
            RETURNING player1_checked_in_at, player2_checked_in_at`
        : await tx.$queryRaw<CheckedIn>`
            UPDATE tournament_matches SET player2_checked_in_at = now()
            WHERE id = ${matchId}::uuid AND player2_id = ${userId}::uuid AND status = 'SCHEDULED'
              AND check_in_deadline > now() AND player2_checked_in_at IS NULL
            RETURNING player1_checked_in_at, player2_checked_in_at`;

      if (rows.length === 0) {
        const current = await this.readState(tx, matchId);
        const mine = slot === 'player1' ? current.player1CheckedIn : current.player2CheckedIn;
        if (mine) return current; // repeated check-in: idempotent
        if (current.status !== 'SCHEDULED') {
          throw new TournamentHttpError(409, 'MATCH_NOT_SCHEDULED', 'This match is not waiting for check-in.');
        }
        throw new TournamentHttpError(409, 'CHECK_IN_CLOSED', 'The check-in deadline has passed.');
      }

      if (rows[0].player1_checked_in_at && rows[0].player2_checked_in_at) {
        // Second player in: start the game in the same transaction (player1 = White).
        created = await this.games.createMatchGame(tx, tournamentId, matchId);
      }
      return this.readState(tx, matchId);
    });

    // In-memory session only after the commit.
    if (created) this.games.startSession(created);
    return state;
  }

  private async readState(tx: Prisma.TransactionClient, matchId: string): Promise<CheckInState> {
    const match = await tx.tournamentMatch.findUniqueOrThrow({
      where: { id: matchId },
      select: {
        id: true, status: true, checkInDeadline: true, player1CheckedInAt: true, player2CheckedInAt: true,
        games: { orderBy: [{ gameStart: 'desc' }, { id: 'desc' }], take: 1, select: { id: true } },
      },
    });
    return {
      matchId: match.id,
      status: match.status as TournamentMatchStatus,
      checkInDeadline: match.checkInDeadline,
      player1CheckedIn: match.player1CheckedInAt !== null,
      player2CheckedIn: match.player2CheckedInAt !== null,
      gameId: match.games[0]?.id ?? null,
    };
  }
}
