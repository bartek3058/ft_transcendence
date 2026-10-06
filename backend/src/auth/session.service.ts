import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { AUTH_CONFIG, AuthConfig } from './auth.config';
import { AuthRepository, SafeAccount, StoredSession } from './auth.repository';
import { storageUnavailable } from './auth.errors';
import { createSessionToken, hashSessionToken } from './session-cookie';
import { safeAccount } from './users.service';

@Injectable()
export class SessionService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private cleanupRunning = false;
  private readonly logger = new Logger(SessionService.name);

  constructor(private readonly repository: AuthRepository,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  async create(userId: string, previousToken: string | null) {
    const token = createSessionToken();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.config.sessionTtlSeconds * 1000);
    try {
      await this.repository.replaceSession(previousToken ? hashSessionToken(previousToken) : null, {
        userId, tokenHash: hashSessionToken(token), createdAt, expiresAt,
      });
    } catch { throw storageUnavailable(); }
    // Only return the cookie material AFTER durable commit succeeds.
    return { token, expiresAt };
  }

  async authenticate(token: string | null): Promise<SafeAccount> {
    if (!token) throw this.unauthenticated();
    let session: StoredSession | null;
    try { session = await this.repository.findSession(hashSessionToken(token)); }
    catch { throw storageUnavailable(); }
    // Check time after the lookup: even a slow DB cannot admit an expired session.
    if (!session || !session.user || session.userId !== session.user.id
      || !Number.isFinite(session.expiresAt.getTime()) || session.expiresAt.getTime() <= Date.now()) {
      throw this.unauthenticated();
    }
    return safeAccount(session.user);
  }

  async revoke(token: string | null): Promise<void> {
    if (!token) return;
    try { await this.repository.deleteSession(hashSessionToken(token)); }
    catch { throw storageUnavailable(); }
  }

  onModuleInit(): void {
    if (!this.repository.configured) {
      this.logger.warn('Auth database adapter is not configured; account operations return 503.');
      return;
    }
    this.timer = setInterval(() => { void this.cleanupExpired(); }, 60 * 60 * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async cleanupExpired(): Promise<void> {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try { await this.repository.deleteExpiredSessions(new Date(), 500); }
    catch { this.logger.warn('Session cleanup failed; expiry remains enforced on every request.'); }
    finally { this.cleanupRunning = false; }
  }

  private unauthenticated(): UnauthorizedException {
    return new UnauthorizedException({ error: { code: 'UNAUTHENTICATED', message: 'Please log in.' } });
  }
}
