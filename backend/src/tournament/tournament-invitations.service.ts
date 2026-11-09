import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { InvitationResponse, InvitationsQueryDto } from './dto/invitation.dto';
import { TournamentHttpError } from './http/tournament.errors';
import { TournamentEventsPublisher } from './tournament-events.publisher';
import { PAGE } from './tournament-rules';
import { JoinResult, mapJoinError, TournamentsService } from './tournaments.service';
import {
  InvitationAnswer, InvitationCreated, InvitationStatusView, MyInvitationsPage,
} from './types/tournament-response.types';
import { TournamentStatus } from './types/tournament.types';

const notFound = () => new TournamentHttpError(404, 'INVITATION_NOT_FOUND', 'Invitation not found.');
const expired = () => new TournamentHttpError(409, 'INVITATION_EXPIRED', 'This invitation has expired.');

type LockedInvitation = {
  id: string;
  tournament_id: string;
  sender_id: string;
  status: InvitationStatusView;
  expires_at: Date;
}[];

// Tournament invitations (#154). Only friends can be invited, accepting reuses the #102 join.
@Injectable()
export class TournamentInvitationsService {
  constructor(private readonly prisma: PrismaService,
    private readonly tournaments: TournamentsService,
    private readonly events: TournamentEventsPublisher) {}

  async invite(senderId: string, tournamentId: string, recipientId: string): Promise<InvitationCreated> {
    if (recipientId === senderId) {
      throw new TournamentHttpError(400, 'SELF_INVITE', 'You cannot invite yourself.');
    }
    const created = await this.prisma.$transaction(async (tx) => {
      // FOR SHARE: a concurrent close/cancel waits for us or commits first and the check below fails
      const tournaments = await tx.$queryRaw<{ status: string; registration_deadline: Date; creator_id: string }[]>`
        SELECT status, registration_deadline, creator_id FROM tournaments
        WHERE id = ${tournamentId}::uuid FOR SHARE`;
      if (tournaments.length === 0) throw new TournamentHttpError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found.');
      const tournament = tournaments[0];
      if (tournament.status !== 'OPEN_FOR_SIGNUP' || tournament.registration_deadline.getTime() <= Date.now()) {
        throw new TournamentHttpError(409, 'REGISTRATION_CLOSED', 'Registration is closed.');
      }

      const senderIsMember = tournament.creator_id === senderId
        || await tx.tournamentParticipant.count({ where: { tournamentId, userId: senderId } }) > 0;
      if (!senderIsMember) {
        throw new TournamentHttpError(403, 'NOT_ALLOWED_TO_INVITE',
          'Only the creator or a registered player can invite.');
      }

      const [userLowId, userHighId] = [senderId, recipientId].sort();
      const friends = await tx.friendship.count({ where: { userLowId, userHighId, status: 'ACCEPTED' } });
      if (!friends) throw new TournamentHttpError(403, 'NOT_FRIEND', 'You can only invite your friends.');

      if (await tx.tournamentParticipant.count({ where: { tournamentId, userId: recipientId } })) {
        throw new TournamentHttpError(409, 'ALREADY_JOINED', 'This player already joined the tournament.');
      }

      // a live pending invite is left alone, a second concurrent sender gets 0 rows
      const rows = await tx.$queryRaw<{ id: string; expires_at: Date }[]>`
        INSERT INTO tournament_invitations (id, tournament_id, sender_id, recipient_id, status, created_at, expires_at)
        VALUES (gen_random_uuid(), ${tournamentId}::uuid, ${senderId}::uuid, ${recipientId}::uuid,
                'PENDING', now(), ${tournament.registration_deadline})
        ON CONFLICT (tournament_id, recipient_id) DO UPDATE
          SET sender_id = EXCLUDED.sender_id, status = 'PENDING',
              created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at
          WHERE tournament_invitations.status <> 'PENDING' OR tournament_invitations.expires_at <= now()
        RETURNING id, expires_at`;
      if (rows.length === 0) {
        throw new TournamentHttpError(409, 'ALREADY_INVITED', 'This player already has a pending invitation.');
      }
      return { invitationId: rows[0].id, expiresAt: rows[0].expires_at };
    });

    this.events.invitationReceived({
      invitationId: created.invitationId, tournamentId, senderId, recipientId, at: new Date(),
    });
    return { ...created, tournamentId, recipientId, status: 'PENDING' };
  }

  async mine(userId: string, query: InvitationsQueryDto): Promise<MyInvitationsPage> {
    const limit = query.limit ? Number(query.limit) : PAGE.defaultLimit;
    const offset = query.offset ? Number(query.offset) : 0;
    const now = new Date();
    const where: Prisma.TournamentInvitationWhereInput = {
      recipientId: userId,
      status: 'PENDING',
      expiresAt: { gt: now },
      tournament: { status: 'OPEN_FOR_SIGNUP', registrationDeadline: { gt: now } },
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.tournamentInvitation.count({ where }),
      this.prisma.tournamentInvitation.findMany({
        where, orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }], skip: offset, take: limit,
        select: {
          id: true, createdAt: true, expiresAt: true,
          sender: { select: { id: true, username: true } },
          tournament: { select: {
            id: true, title: true, status: true, maxParticipants: true, currentParticipants: true,
            registrationDeadline: true,
          } },
        },
      }),
    ]);
    return {
      items: rows.map((r) => ({ ...r, tournament: { ...r.tournament, status: r.tournament.status as TournamentStatus } })),
      total, limit, offset,
    };
  }

  async respond(userId: string, invitationId: string, response: InvitationResponse): Promise<InvitationAnswer> {
    // `as` stops TS from narrowing it to null
    let joined = null as JoinResult | null;
    let declined = null as { tournamentId: string; senderId: string } | null;
    let answer: InvitationAnswer;
    try {
      answer = await this.prisma.$transaction(async (tx) => {
        const target = await tx.tournamentInvitation.findFirst({
          where: { id: invitationId, recipientId: userId }, select: { tournamentId: true },
        });
        if (!target) throw notFound(); // also for someone else's invitation
        // same lock order as join/invite/close/cancel (tournament, then invitations) to avoid deadlocks
        await tx.$queryRaw`SELECT id FROM tournaments WHERE id = ${target.tournamentId}::uuid FOR NO KEY UPDATE`;
        const rows = await tx.$queryRaw<LockedInvitation>`
          SELECT id, tournament_id, sender_id, status, expires_at FROM tournament_invitations
          WHERE id = ${invitationId}::uuid AND recipient_id = ${userId}::uuid
          FOR UPDATE`;
        if (rows.length === 0) throw notFound();
        const inv = rows[0];
        const base = { invitationId: inv.id, tournamentId: inv.tournament_id };
        const wanted = response === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED';

        if (inv.status === wanted) return { ...base, status: inv.status }; // repeated answer
        if (inv.status === 'EXPIRED') throw expired();
        if (inv.status !== 'PENDING') {
          throw new TournamentHttpError(409, 'INVITATION_ALREADY_ANSWERED', 'This invitation was already answered.');
        }
        if (inv.expires_at.getTime() <= Date.now()) throw expired();

        if (response === 'DECLINE') {
          await tx.tournamentInvitation.update({ where: { id: inv.id }, data: { status: 'DECLINED' } });
          declined = { tournamentId: inv.tournament_id, senderId: inv.sender_id };
          return { ...base, status: 'DECLINED' };
        }
        // if the join fails the whole thing rolls back and the invite stays PENDING
        joined = await this.tournaments.joinInTx(tx, userId, inv.tournament_id);
        return { ...base, status: 'ACCEPTED', currentParticipants: joined.currentParticipants };
      });
    } catch (error) {
      throw mapJoinError(error);
    }

    if (joined) this.tournaments.publishJoined(userId, answer.tournamentId, joined);
    if (declined) {
      this.events.invitationAnswered({
        invitationId, tournamentId: declined.tournamentId, senderId: declined.senderId, recipientId: userId,
        status: 'DECLINED', at: new Date(),
      });
    }
    return answer;
  }
}
