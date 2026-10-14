import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthRepository } from './auth.repository';
import { storageUnavailable } from './auth.errors';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { PasswordService } from './password.service';
import { UsersService, safeAccount } from './users.service';
import { SessionService } from './session.service';

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
}
