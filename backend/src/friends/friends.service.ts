import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PresenceService } from './presence.service';
import { PageDto, RequestsDto, SearchDto } from './friends.dto';

const publicUser = { id: true, username: true, rating: true } as const;
const membership = (id: string) => ({ OR: [{ userLowId: id }, { userHighId: id }] });
const notFound = () => new NotFoundException({ error: { code: 'NOT_FOUND', message: 'User or relationship not found.' } });
const conflict = () => new ConflictException({ error: { code: 'FRIENDSHIP_CONFLICT', message: 'Relationship already exists or has changed. Refresh and retry.' } });
const page = (q: PageDto) => ({ take: Number(q.limit ?? 20) + 1, skip: Number(q.offset ?? 0) });
function paged<T>(items: T[], q: PageDto) {
  const limit = Number(q.limit ?? 20);
  return { items: items.slice(0, limit), hasMore: items.length > limit, offset: Number(q.offset ?? 0), limit };
}
@Injectable()
export class FriendsService {
  constructor(private readonly prisma: PrismaService, private readonly presence: PresenceService) {}
  async search(me: string, q: SearchDto) {
    const users = await this.prisma.user.findMany({ where: { id: { not: me }, username: { startsWith: q.q.replace(/_/g, '\\_') } },
      select: publicUser, orderBy: [{ username: 'asc' }, { id: 'asc' }], ...page(q) });
    return paged(users, q);
  }
  async profile(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: publicUser });
    if (!user) throw notFound();
    return { user };
  }
  async list(me: string, q: PageDto) {
    const rows = await this.prisma.friendship.findMany({ where: { ...membership(me), status: 'ACCEPTED' },
      include: { userLow: { select: publicUser }, userHigh: { select: publicUser } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...page(q) });
    return paged(rows.map(row => {
      const user = row.userLowId === me ? row.userHigh : row.userLow;
      return { friendshipId: row.id, user: { ...user, online: this.presence.isOnline(user.id) }, acceptedAt: row.acceptedAt };
    }), q);
  }
  async requests(me: string, q: RequestsDto) {
    const rows = await this.prisma.friendship.findMany({ where: { ...membership(me), status: 'PENDING',
      ...(q.direction ? { requestedById: q.direction === 'outgoing' ? me : { not: me } } : {}) },
      include: { userLow: { select: publicUser }, userHigh: { select: publicUser } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...page(q) });
    return paged(rows.map(row => ({ id: row.id, direction: row.requestedById === me ? 'outgoing' : 'incoming',
      user: row.userLowId === me ? row.userHigh : row.userLow, createdAt: row.createdAt })), q);
  }
  async send(me: string, target: string) {
    target = target.toLowerCase();
    if (me === target) throw new BadRequestException({ error: { code: 'SELF_REQUEST', message: 'You cannot add yourself.' } });
    if (!await this.prisma.user.findUnique({ where: { id: target }, select: { id: true } })) throw notFound();
    const [userLowId, userHighId] = [me, target].sort();
    try {
      const row = await this.prisma.friendship.create({ data: { userLowId, userHighId, requestedById: me },
        select: { id: true, status: true, createdAt: true } });
      this.presence.changed(me, target);
      return { request: row };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') throw conflict();
        if (error.code === 'P2003') throw notFound();
      }
      throw error;
    }
  }
  async accept(me: string, id: string) {
    // Conditional write is the concurrency gate. No read-then-unconditional-update.
    const row = await this.prisma.$transaction(async tx => {
      const result = await tx.friendship.updateMany({ where: { id, ...membership(me), status: 'PENDING',
        requestedById: { not: me } }, data: { status: 'ACCEPTED', acceptedAt: new Date() } });
      if (!result.count) throw notFound();
      return tx.friendship.findUniqueOrThrow({ where: { id }, select: { userLowId: true, userHighId: true } });
    });
    this.presence.changed(row.userLowId, row.userHighId);
  }
  async removeRequest(me: string, id: string) {
    const row = await this.prisma.$transaction(async tx => {
      const existing = await tx.friendship.findFirst({ where: { id, ...membership(me), status: 'PENDING' },
        select: { userLowId: true, userHighId: true } });
      if (!existing) throw notFound();
      const result = await tx.friendship.deleteMany({ where: { id, ...membership(me), status: 'PENDING' } });
      if (!result.count) throw notFound();
      return existing;
    });
    this.presence.changed(row.userLowId, row.userHighId);
  }
  async removeFriend(me: string, other: string) {
    const [userLowId, userHighId] = [me, other.toLowerCase()].sort();
    const result = await this.prisma.friendship.deleteMany({ where: { userLowId, userHighId, status: 'ACCEPTED' } });
    // Idempotent, including a repeated removal. No relationship data is disclosed.
    if (result.count) this.presence.changed(me, other.toLowerCase());
  }
}
