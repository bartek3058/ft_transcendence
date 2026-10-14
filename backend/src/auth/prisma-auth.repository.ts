import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AccountConflictError, AuthRepository, NewAccount, NewSession } from './auth.repository';

const safeUser = { id: true, email: true, username: true, createdAt: true } as const;
const account = { ...safeUser, passwordHash: true } as const;

@Injectable()
export class PrismaAuthRepository extends AuthRepository {
  readonly configured = true;
  constructor(private readonly prisma: PrismaService) { super(); }

  async createAccount(input: NewAccount) {
    try {
      return await this.prisma.user.create({ data: input, select: account });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = error.meta?.target;
        if ((Array.isArray(target) && target.length === 1 && ['email', 'username'].includes(target[0]))
          || target === 'users_email_key' || target === 'users_username_key') {
          throw new AccountConflictError();
        }
      }
      throw error;
    }
  }

  findAccountByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email }, select: account });
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
