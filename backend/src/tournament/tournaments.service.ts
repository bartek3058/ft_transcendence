import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CreateTournamentDto } from './dto/create-tournament.dto';
import { ListTournamentsQueryDto } from './dto/list-tournaments-query.dto';
import { TournamentHttpError } from './http/tournament.errors';
import { TournamentEventsPublisher } from './tournament-events.publisher';
import { CloseOutcome, TournamentLifecycleService } from './tournament-lifecycle.service';
import { checkRegistrationDeadline, PAGE, TAB_STATUSES } from './tournament-rules';
import {
  RegistrationChange, TournamentDetail, TournamentPage, TournamentSummary,
} from './types/tournament-response.types';
import { TournamentMatchSlot, TournamentMatchStatus, TournamentStatus } from './types/tournament.types';

// never select users.rating for a response
const USER_REF = { select: { id: true, username: true } } as const;

const SUMMARY_SELECT = {
  id: true, title: true, description: true, status: true, maxParticipants: true,
  currentParticipants: true, registrationDeadline: true, startedAt: true, completedAt: true,
  createdAt: true, creator: USER_REF, champion: USER_REF,
} satisfies Prisma.TournamentSelect;

type SummaryRow = Prisma.TournamentGetPayload<{ select: typeof SUMMARY_SELECT }>;

const ORDER: Record<keyof typeof TAB_STATUSES, Prisma.TournamentOrderByWithRelationInput[]> = {
  open: [{ registrationDeadline: 'asc' }, { id: 'asc' }],
  live: [{ startedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
  past: [{ createdAt: 'desc' }, { id: 'asc' }],
};

const notFound = () => new TournamentHttpError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found.');
const closed = () => new TournamentHttpError(409, 'REGISTRATION_CLOSED', 'Registration is closed.');
const alreadyJoined = () => new TournamentHttpError(409, 'ALREADY_JOINED', 'You already joined this tournament.');
export interface JoinResult {
  currentParticipants: number;
  maxParticipants: number;
  username: string;
  // a pending invite for this tournament, marked ACCEPTED by the join
  acceptedInvitation: { id: string; senderId: string } | null;
}

const notJoined = () => new TournamentHttpError(409, 'NOT_JOINED', 'You are not registered in this tournament.');

@Injectable()
export class TournamentsService {
  constructor(private readonly prisma: PrismaService,
    private readonly lifecycle: TournamentLifecycleService,
    private readonly events: TournamentEventsPublisher) {}

  async create(creatorId: string, dto: CreateTournamentDto): Promise<TournamentSummary> {
    const registrationDeadline = new Date(dto.registrationDeadline);
    const problem = checkRegistrationDeadline(registrationDeadline, new Date());
    if (problem === 'TOO_SOON') {
      throw new TournamentHttpError(400, 'DEADLINE_TOO_SOON', 'Registration deadline must be at least 5 minutes ahead.');
    }
    if (problem === 'TOO_FAR') {
      throw new TournamentHttpError(400, 'DEADLINE_TOO_FAR', 'Registration deadline must be at most 30 days ahead.');
    }
    const row = await this.prisma.tournament.create({
      data: {
        title: dto.title,
        description: dto.description ? dto.description : null,
        maxParticipants: dto.maxParticipants,
        registrationDeadline,
        creatorId,
        status: 'OPEN_FOR_SIGNUP',
      },
      select: SUMMARY_SELECT,
    });
    return toSummary(row);
  }

  async list(query: ListTournamentsQueryDto): Promise<TournamentPage> {
    const tab = query.status ?? 'open';
    const limit = query.limit ? Number(query.limit) : PAGE.defaultLimit;
    const offset = query.offset ? Number(query.offset) : 0;
    const where = { status: { in: [...TAB_STATUSES[tab]] } };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.tournament.count({ where }),
      this.prisma.tournament.findMany({ where, orderBy: ORDER[tab], skip: offset, take: limit, select: SUMMARY_SELECT }),
    ]);
    return { items: rows.map(toSummary), total, limit, offset };
  }

  async detail(id: string): Promise<TournamentDetail> {
    const row = await this.prisma.tournament.findUnique({
      where: { id },
      select: {
        ...SUMMARY_SELECT,
        participants: {
          orderBy: [{ seed: { sort: 'asc', nulls: 'last' } }, { registeredAt: 'asc' }, { id: 'asc' }],
          select: {
            userId: true, seed: true, seedRating: true, finalRank: true, registeredAt: true,
            user: { select: { username: true } },
          },
        },
        matches: {
          orderBy: [{ round: 'asc' }, { matchIndex: 'asc' }],
          select: {
            id: true, round: true, matchIndex: true, identifier: true, status: true, isBye: true,
            winnerId: true, nextMatchId: true, nextMatchSlot: true,
            checkInDeadline: true, player1CheckedInAt: true, player2CheckedInAt: true,
            player1: USER_REF, player2: USER_REF,
            games: { orderBy: [{ gameStart: 'asc' }, { id: 'asc' }], select: { id: true } },
          },
        },
      },
    });
    if (!row) throw notFound();
    const { participants, matches, ...summary } = row;
    return {
      ...toSummary(summary),
      participants: participants.map((p) => ({
        userId: p.userId, username: p.user.username, seed: p.seed, seedRating: p.seedRating,
        finalRank: p.finalRank, registeredAt: p.registeredAt,
      })),
      matches: matches.map(({ games, player1CheckedInAt, player2CheckedInAt, ...m }) => ({
        ...m,
        player1CheckedIn: player1CheckedInAt !== null,
        player2CheckedIn: player2CheckedInAt !== null,
        status: m.status as TournamentMatchStatus,
        nextMatchSlot: m.nextMatchSlot as TournamentMatchSlot | null,
        gameIds: games.map((g) => g.id),
        currentGameId: games.length ? games[games.length - 1].id : null,
      })),
    };
  }

  async join(userId: string, id: string): Promise<RegistrationChange> {
    let result: JoinResult;
    try {
      result = await this.prisma.$transaction((tx) => this.joinInTx(tx, userId, id));
    } catch (error) {
      throw mapJoinError(error);
    }
    this.publishJoined(userId, id, result);
    return { currentParticipants: result.currentParticipants };
  }

  /* One conditional UPDATE, so the last slot can't be overbooked. A duplicate throws P2002,
  map it with mapJoinError outside the transaction. */
  async joinInTx(tx: Prisma.TransactionClient, userId: string, id: string): Promise<JoinResult> {
    const rows = await tx.$queryRaw<{ current_participants: number; max_participants: number }[]>`
      UPDATE tournaments
      SET current_participants = current_participants + 1, updated_at = now()
      WHERE id = ${id}::uuid
        AND status = 'OPEN_FOR_SIGNUP'
        AND current_participants < max_participants
        AND registration_deadline > now()
      RETURNING current_participants, max_participants`;
    if (rows.length === 0) throw await this.joinRejection(tx, id, userId);
    await tx.tournamentParticipant.create({ data: { tournamentId: id, userId } });
    const accepted = await tx.$queryRaw<{ id: string; sender_id: string }[]>`
      UPDATE tournament_invitations SET status = 'ACCEPTED'
      WHERE tournament_id = ${id}::uuid AND recipient_id = ${userId}::uuid AND status = 'PENDING'
      RETURNING id, sender_id`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { username: true } });
    return {
      currentParticipants: rows[0].current_participants,
      maxParticipants: rows[0].max_participants,
      username: user.username,
      acceptedInvitation: accepted.length ? { id: accepted[0].id, senderId: accepted[0].sender_id } : null,
    };
  }

  publishJoined(userId: string, tournamentId: string, result: JoinResult): void {
    this.events.participantJoined({
      tournamentId, userId, username: result.username, currentParticipants: result.currentParticipants,
      maxParticipants: result.maxParticipants, at: new Date(),
    });
    if (!result.acceptedInvitation) return;
    this.events.invitationAnswered({
      invitationId: result.acceptedInvitation.id, tournamentId, senderId: result.acceptedInvitation.senderId,
      recipientId: userId, status: 'ACCEPTED', at: new Date(),
    });
  }

  async leave(userId: string, id: string): Promise<RegistrationChange> {
    const left = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ current_participants: number; max_participants: number }[]>`
        UPDATE tournaments
        SET current_participants = current_participants - 1, updated_at = now()
        WHERE id = ${id}::uuid
          AND status = 'OPEN_FOR_SIGNUP'
          AND registration_deadline > now()
          AND current_participants > 0
        RETURNING current_participants, max_participants`;
      if (rows.length === 0) {
        const tournament = await tx.tournament.findUnique({
          where: { id }, select: { status: true, registrationDeadline: true },
        });
        if (!tournament) throw notFound();
        if (!isOpen(tournament.status, tournament.registrationDeadline)) throw closed();
        throw notJoined();
      }
      const removed = await tx.tournamentParticipant.deleteMany({ where: { tournamentId: id, userId } });
      if (removed.count === 0) throw notJoined(); // rolls back the decrement
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { username: true } });
      return { currentParticipants: rows[0].current_participants, maxParticipants: rows[0].max_participants, username: user.username };
    });
    this.events.participantLeft({ tournamentId: id, userId, ...left, at: new Date() });
    return { currentParticipants: left.currentParticipants };
  }

  async closeRegistration(userId: string, id: string): Promise<{ status: CloseOutcome }> {
    await this.assertCreatorOrAdmin(userId, id);
    return { status: await this.lifecycle.closeAndStart(id, 'MANUAL') };
  }

  async cancel(userId: string, id: string): Promise<{ status: 'CANCELLED' }> {
    await this.assertCreatorOrAdmin(userId, id);
    await this.lifecycle.cancel(id);
    return { status: 'CANCELLED' };
  }

  // SafeAccount has no role, so read it from the DB
  private async assertCreatorOrAdmin(userId: string, id: string): Promise<void> {
    const [tournament, user] = await Promise.all([
      this.prisma.tournament.findUnique({ where: { id }, select: { creatorId: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } }),
    ]);
    if (!tournament) throw notFound();
    if (tournament.creatorId !== userId && user?.role !== 'admin') {
      throw new TournamentHttpError(403, 'FORBIDDEN', 'Only the creator or an admin can do this.');
    }
  }

  private async joinRejection(tx: Prisma.TransactionClient, id: string, userId: string) {
    const tournament = await tx.tournament.findUnique({
      where: { id },
      select: { status: true, registrationDeadline: true, currentParticipants: true, maxParticipants: true },
    });
    if (!tournament) return notFound();
    const member = await tx.tournamentParticipant.count({ where: { tournamentId: id, userId } });
    if (member) return alreadyJoined();
    if (!isOpen(tournament.status, tournament.registrationDeadline)) return closed();
    return new TournamentHttpError(409, 'TOURNAMENT_FULL', 'Tournament is full.');
  }
}

export function mapJoinError(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return alreadyJoined();
  return error;
}

function isOpen(status: string, deadline: Date): boolean {
  return status === 'OPEN_FOR_SIGNUP' && deadline.getTime() > Date.now();
}

function toSummary(row: SummaryRow): TournamentSummary {
  return { ...row, status: row.status as TournamentStatus };
}
