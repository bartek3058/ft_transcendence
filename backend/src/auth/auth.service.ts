import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { AccountConflictError, AuthRepository, SafeAccount } from './auth.repository';
import { storageUnavailable } from './auth.errors';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { PasswordService } from './password.service';
import { UsersService, safeAccount } from './users.service';
import { SessionService } from './session.service';
import { displayNameKey } from './validation/display-name';

@Injectable()
export class AuthService {
  constructor(private readonly users: UsersService, private readonly passwords: PasswordService,
    private readonly sessions: SessionService, private readonly repository: AuthRepository) {}

  async register(dto: RegisterDto) {
    if (!this.repository.configured) throw storageUnavailable();
    const passwordHash = await this.passwords.hash(dto.password);
    return this.users.create({ email: dto.email, username: dto.username, passwordHash });
  }

  async login(dto: LoginDto, previousToken: string | null) {
    const account = await this.users.findByEmail(dto.email);
    const matches = await this.passwords.verify(dto.password, account?.passwordHash ?? null);
    if (!account || !matches) {
      throw new UnauthorizedException({ error: {
        code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.',
      } });
    }
    const session = await this.sessions.create(account.id, previousToken);
    return { user: safeAccount(account), session };
  }

  // displayName is already normalized and validated, "" clears it
  async updateDisplayName(account: SafeAccount, displayName: string): Promise<SafeAccount> {
    const name = displayName === '' ? null : displayName;
    let updated: SafeAccount | null;
    try { updated = await this.repository.updateDisplayName(account.id, name, name && displayNameKey(name)); }
    catch (error) {
      if (error instanceof AccountConflictError) {
        throw new ConflictException({ error: {
          code: 'DISPLAY_NAME_TAKEN', message: 'This name is already used by another player.',
        } });
      }
      throw storageUnavailable();
    }
    // the account was deleted after the session check
    if (!updated) throw this.unauthenticated();
    return safeAccount(updated);
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException({ error: {
        code: 'PASSWORD_UNCHANGED', message: 'The new password must be different.',
      } });
    }
    let account;
    try { account = await this.repository.findAccountById(userId); }
    catch { throw storageUnavailable(); }
    if (!account) throw this.unauthenticated();
    if (!await this.passwords.verify(dto.currentPassword, account.passwordHash)) {
      // 400, not 401: the session is fine, only the confirmation failed
      throw new BadRequestException({ error: {
        code: 'INVALID_CURRENT_PASSWORD', message: 'Current password is incorrect.',
      } });
    }
    const passwordHash = await this.passwords.hash(dto.newPassword);
    const session = await this.sessions.replaceAllWithPassword(userId, account.passwordHash, passwordHash);
    if (!session) {
      throw new ConflictException({ error: {
        code: 'PASSWORD_CHANGED_CONCURRENTLY', message: 'The password was changed meanwhile. Please try again.',
      } });
    }
    return session;
  }

  private unauthenticated(): UnauthorizedException {
    return new UnauthorizedException({ error: { code: 'UNAUTHENTICATED', message: 'Please log in.' } });
  }
}
