import { BadRequestException, Injectable, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { isValidPassword, PASSWORD_MIN_LENGTH } from './validation/input-rules';

export const PASSWORD_HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
};

@Injectable()
export class PasswordService implements OnModuleInit {
  private activeJobs = 0;
  private dummyHash!: string;

  async onModuleInit(): Promise<void> {
    // One dummy hash per process, at the same cost as real accounts.
    this.dummyHash = await argon2.hash(randomBytes(32), PASSWORD_HASH_OPTIONS);
  }

  async hash(password: string): Promise<string> {
    if (!isValidPassword(password, PASSWORD_MIN_LENGTH)) {
      throw new BadRequestException({ error: {
        code: 'INVALID_INPUT', message: 'Password does not satisfy the password policy.',
      } });
    }
    return this.run(() => argon2.hash(password, PASSWORD_HASH_OPTIONS));
  }

  async verify(password: string, encodedHash: string | null): Promise<boolean> {
    if (!isValidPassword(password, 1)) return false;
    if (!this.dummyHash) throw new Error('PasswordService must be initialized before use.');
    const matches = await this.run(() => argon2.verify(encodedHash ?? this.dummyHash, password));
    return encodedHash !== null && matches;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    // Bound memory use (2 x 64 MiB) without an unbounded waiting queue.
    // Request/account rate limiting is still required when routes are introduced.
    if (this.activeJobs >= 2) {
      throw new ServiceUnavailableException({ error: {
        code: 'AUTH_BUSY', message: 'Authentication is busy. Please retry shortly.',
      } });
    }
    this.activeJobs++;
    try {
      return await operation();
    } finally {
      this.activeJobs--;
    }
  }
}
