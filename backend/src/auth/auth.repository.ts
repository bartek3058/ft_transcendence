/** Implement with Prisma in DatabaseModule; no production in-memory storage. */
export interface Account {
  id: string;
  email: string;
  username: string;
  passwordHash: string;
  createdAt: Date;
}

export type SafeAccount = Omit<Account, 'passwordHash'>;
export type NewAccount = Pick<Account, 'email' | 'username' | 'passwordHash'>;

export interface NewSession {
  userId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface StoredSession extends NewSession {
  user: SafeAccount;
}

/** Adapter maps ONLY email/username unique violations to this error. */
export class AccountConflictError extends Error {}

export abstract class AuthRepository {
  abstract readonly configured: boolean;
  abstract createAccount(account: NewAccount): Promise<Account>;
  abstract findAccountByEmail(email: string): Promise<Account | null>;
  /** Delete previousTokenHash (if present) + insert in ONE DB transaction. */
  abstract replaceSession(previousTokenHash: string | null, session: NewSession): Promise<void>;
  abstract findSession(tokenHash: string): Promise<StoredSession | null>;
  /** Idempotent; a persistence failure must still reject. */
  abstract deleteSession(tokenHash: string): Promise<void>;
  /** Delete at most limit expired rows, using the expiry index. */
  abstract deleteExpiredSessions(now: Date, limit: number): Promise<number>;
}
