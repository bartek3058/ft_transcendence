import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { TournamentsService } from '../tournaments.service';
import { TournamentMatchStatus } from '../types/tournament.types';
import { TournamentDetail } from '../types/tournament-response.types';

// Socket payloads (#168). Read after the transaction committed; REST stays the source of
// truth, so a client that (re)connects fetches GET /api/tournaments/:id.
// No emails, no session data; the only rating is the frozen seedRating.

export interface MatchPayload {
  id: string;
  round: number;
  identifier: string;
  status: TournamentMatchStatus;
  player1Id: string | null;
  player2Id: string | null;
  winnerId: string | null;
  checkInDeadline: Date | null;
  player1CheckedIn: boolean;
  player2CheckedIn: boolean;
  /** Live game of the match (or the last one played); what the board joins on /game. */
  currentGameId: string | null;
}

export interface StartedPayload {
  tournamentId: string;
  participants: TournamentDetail['participants'];
  matches: TournamentDetail['matches'];
}

export interface FinishedPayload {
  tournamentId: string;
  championId: string | null;
  finalRanks: { userId: string; username: string; finalRank: number }[];
}

export interface InvitationReceivedPayload {
  invitation: {
    id: string;
    tournamentId: string;
    title: string;
    sender: { userId: string; username: string };
    expiresAt: Date;
  };
}

export interface InvitationAnsweredPayload {
  invitation: {
    id: string;
    tournamentId: string;
    title: string;
    recipient: { userId: string; username: string };
    status: 'ACCEPTED' | 'DECLINED';
  };
}

@Injectable()
export class TournamentRealtimePayloads {
  constructor(private readonly prisma: PrismaService,
    private readonly tournaments: TournamentsService) {}

  async matches(tournamentId: string, matchIds: string[]): Promise<MatchPayload[]> {
    const rows = await this.prisma.tournamentMatch.findMany({
      where: { tournamentId, id: { in: matchIds } },
      orderBy: [{ round: 'asc' }, { matchIndex: 'asc' }],
      select: {
        id: true, round: true, identifier: true, status: true, player1Id: true, player2Id: true, winnerId: true,
        checkInDeadline: true, player1CheckedInAt: true, player2CheckedInAt: true,
        games: { orderBy: [{ gameStart: 'desc' }, { id: 'desc' }], take: 1, select: { id: true } },
      },
    });
    return rows.map(({ player1CheckedInAt, player2CheckedInAt, games, ...m }) => ({
      ...m,
      status: m.status as TournamentMatchStatus,
      player1CheckedIn: player1CheckedInAt !== null,
      player2CheckedIn: player2CheckedInAt !== null,
      currentGameId: games[0]?.id ?? null,
    }));
  }

  /** Bracket snapshot (rounds, matches, seeds) from the same query as the REST detail. */
  async started(tournamentId: string): Promise<StartedPayload> {
    const detail = await this.tournaments.detail(tournamentId);
    return { tournamentId, participants: detail.participants, matches: detail.matches };
  }

  async finished(tournamentId: string): Promise<FinishedPayload> {
    const t = await this.prisma.tournament.findUniqueOrThrow({
      where: { id: tournamentId },
      select: {
        championId: true,
        participants: {
          where: { finalRank: { not: null } },
          orderBy: [{ finalRank: 'asc' }, { seed: 'asc' }],
          select: { userId: true, finalRank: true, user: { select: { username: true } } },
        },
      },
    });
    return {
      tournamentId,
      championId: t.championId,
      finalRanks: t.participants.map((p) => ({ userId: p.userId, username: p.user.username, finalRank: p.finalRank! })),
    };
  }

  async invitationReceived(invitationId: string): Promise<InvitationReceivedPayload> {
    const inv = await this.prisma.tournamentInvitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: {
        id: true, tournamentId: true, expiresAt: true,
        tournament: { select: { title: true } }, sender: { select: { id: true, username: true } },
      },
    });
    return { invitation: {
      id: inv.id, tournamentId: inv.tournamentId, title: inv.tournament.title,
      sender: { userId: inv.sender.id, username: inv.sender.username }, expiresAt: inv.expiresAt,
    } };
  }

  async invitationAnswered(invitationId: string, status: 'ACCEPTED' | 'DECLINED'): Promise<InvitationAnsweredPayload> {
    const inv = await this.prisma.tournamentInvitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: {
        id: true, tournamentId: true,
        tournament: { select: { title: true } }, recipient: { select: { id: true, username: true } },
      },
    });
    return { invitation: {
      id: inv.id, tournamentId: inv.tournamentId, title: inv.tournament.title,
      recipient: { userId: inv.recipient.id, username: inv.recipient.username }, status,
    } };
  }

  async tournamentExists(tournamentId: string): Promise<boolean> {
    return (await this.prisma.tournament.count({ where: { id: tournamentId } })) > 0;
  }
}
