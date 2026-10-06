import { Injectable } from '@nestjs/common';
import { Account, AuthRepository, NewAccount, NewSession, StoredSession } from './auth.repository';

@Injectable()
export class UnavailableAuthRepository extends AuthRepository {
  readonly configured = false;

  private unavailable(): never {
    throw new Error('Auth database adapter is not configured.');
  }

  async createAccount(_account: NewAccount): Promise<Account> { return this.unavailable(); }
  async findAccountByEmail(_email: string): Promise<Account | null> { return this.unavailable(); }
  async replaceSession(_previous: string | null, _session: NewSession): Promise<void> { return this.unavailable(); }
  async findSession(_tokenHash: string): Promise<StoredSession | null> { return this.unavailable(); }
  async deleteSession(_tokenHash: string): Promise<void> { return this.unavailable(); }
  async deleteExpiredSessions(_now: Date, _limit: number): Promise<number> { return this.unavailable(); }
}
