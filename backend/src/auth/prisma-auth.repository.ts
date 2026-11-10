import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AccountConflictError, AuthRepository, NewAccount, NewSession } from './auth.repository';

const safeUser = { id: true, email: true, username: true, createdAt: true } as const;
const account = { ...safeUser, passwordHash: true } as const;

// The username index is on lower(username), Prisma reports it as ["lower(username::text)"].
const IDENTITY_FIELDS = ['email', 'username', 'lower(username::text)'];
const IDENTITY_KEYS = ['users_email_key', 'users_username_key', 'users_username_lower_key'];

function isIdentityConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = error.meta?.target;
  return (Array.isArray(target) && target.length === 1 && IDENTITY_FIELDS.includes(target[0]))
    || (typeof target === 'string' && IDENTITY_KEYS.includes(target));
}

@Injectable()
export class PrismaAuthRepository extends AuthRepository {
  readonly configured = true;
  constructor(private readonly prisma: PrismaService) { super(); }

  async createAccount(input: NewAccount) {
    try {
      return await this.prisma.user.create({ data: input, select: account });
    } catch (error) {
      if (isIdentityConflict(error)) throw new AccountConflictError();
      throw error;
    }
  }

  findAccountByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email }, select: account });
  }

  findAccountById(id: string) {
    return this.prisma.user.findUnique({ where: { id }, select: account });
  }

  async updateUsername(id: string, username: string) {
    try {
      return await this.prisma.user.update({ where: { id }, data: { username }, select: safeUser });
    } catch (error) {
      if (isIdentityConflict(error)) throw new AccountConflictError();
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return null;
      throw error;
    }
  }

  async changePassword(userId: string, expectedHash: string, passwordHash: string, session: NewSession) {
    return this.prisma.$transaction(async (tx) => {
      // compare-and-swap, also locks the user row so two changes run one after the other
      const { count } = await tx.user.updateMany({
        where: { id: userId, passwordHash: expectedHash }, data: { passwordHash },
      });
      if (count !== 1) return null;
      // RETURNING gives exactly the rows deleted, including a login that raced us
      const dropped = await tx.$queryRaw<{ token_hash: string }[]>`
        DELETE FROM sessions WHERE user_id = ${userId}::uuid RETURNING token_hash`;
      await tx.session.create({ data: session });
      return dropped.map((row) => row.token_hash);
    });
  }

  async replaceSession(previousTokenHash: string | null, session: NewSession): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (previousTokenHash) await tx.session.deleteMany({ where: { tokenHash: previousTokenHash } });
      await tx.session.create({ data: session });
    });
  }

  findSession(tokenHash: string) {
    return this.prisma.session.findUnique({ where: { tokenHash }, select: {
      userId: true, tokenHash: true, createdAt: true, expiresAt: true,
      user: { select: safeUser },
    } });
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { tokenHash } });
  }

  async deleteExpiredSessions(now: Date, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError('Session cleanup limit must be between 1 and 500.');
    }
    // One bounded statement; concurrent workers skip rows already being cleaned.
    return this.prisma.$executeRaw`
      DELETE FROM sessions WHERE id IN (
        SELECT id FROM sessions WHERE expires_at <= ${now}
        ORDER BY expires_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED
      )`;
  }
}
