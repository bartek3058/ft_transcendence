import { ConflictException, Injectable } from '@nestjs/common';
import { Account, AccountConflictError, AuthRepository, NewAccount, SafeAccount } from './auth.repository';
import { storageUnavailable } from './auth.errors';

export function safeAccount(account: SafeAccount): SafeAccount {
  return { id: account.id, email: account.email, username: account.username, createdAt: account.createdAt };
}

@Injectable()
export class UsersService {
  constructor(private readonly repository: AuthRepository) {}

  async create(account: NewAccount): Promise<SafeAccount> {
    try { return safeAccount(await this.repository.createAccount(account)); }
    catch (error) {
      if (error instanceof AccountConflictError) {
        throw new ConflictException({ error: {
          code: 'ACCOUNT_CONFLICT', message: 'Email or username is unavailable.',
        } });
      }
      throw storageUnavailable();
    }
  }

  async findByEmail(email: string): Promise<Account | null> {
    try { return await this.repository.findAccountByEmail(email); }
    catch { throw storageUnavailable(); }
  }
}
