/** Implement with Prisma in DatabaseModule; no production in-memory storage. */
export interface Account {
  id: string;
  email: string;
  username: string;
  // null = not set, show the username
  displayName: string | null;
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
  abstract findAccountById(id: string): Promise<Account | null>;
  /**
   * Sets (or clears, with nulls) the display name. null when the account is gone.
   * Throws AccountConflictError when the key is used by another display name or
   * matches another user's username.
   */
  abstract updateDisplayName(id: string, displayName: string | null, key: string | null): Promise<SafeAccount | null>;
  /**
   * In ONE transaction: swap the hash only if it is still `expectedHash`, drop every session
   * of the user and insert `session`. Returns the dropped token hashes, or null when the hash
   * changed in the meantime (nothing is written then).
   */
  abstract changePassword(userId: string, expectedHash: string, passwordHash: string,
    session: NewSession): Promise<string[] | null>;
  /** Delete previousTokenHash (if present) + insert in ONE DB transaction. */
  abstract replaceSession(previousTokenHash: string | null, session: NewSession): Promise<void>;
  abstract findSession(tokenHash: string): Promise<StoredSession | null>;
  /** Idempotent; a persistence failure must still reject. */
  abstract deleteSession(tokenHash: string): Promise<void>;
  /** Delete at most limit expired rows, using the expiry index. */
  abstract deleteExpiredSessions(now: Date, limit: number): Promise<number>;
}
