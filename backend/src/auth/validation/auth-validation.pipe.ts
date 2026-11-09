import { ArgumentMetadata, BadRequestException, Injectable, ValidationPipe } from '@nestjs/common';
import { LoginDto } from '../dto/login.dto';
import { RegisterDto } from '../dto/register.dto';
import { LogoutDto } from '../dto/logout.dto';
import { UpdateAccountDto } from '../dto/update-account.dto';
import { ChangePasswordDto } from '../dto/change-password.dto';

const ECHOED_FIELDS = ['email', 'username', 'password', 'displayName', 'currentPassword', 'newPassword'];

// Allowed top-level keys for each auth body.
const ALLOWED_KEYS = new Map<unknown, string[]>([
  [RegisterDto, ['email', 'username', 'password']],
  [LoginDto, ['email', 'password']],
  [LogoutDto, []],
  [UpdateAccountDto, ['displayName']],
  [ChangePasswordDto, ['currentPassword', 'newPassword']],
]);

function invalidInput(fields: { field: string; code: string }[] = []) {
  return new BadRequestException({ error: {
    code: 'INVALID_INPUT', message: 'Request validation failed.', fields,
  } });
}

@Injectable()
export class AuthValidationPipe extends ValidationPipe {
  constructor() {
    super({
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: { target: false, value: false },
      exceptionFactory: (errors) => invalidInput(errors.map((error) => ({
        // Never echo an attacker-controlled property name or rejected value.
        field: ECHOED_FIELDS.includes(error.property) ? error.property : 'body',
        code: error.constraints?.whitelistValidation ? 'UNEXPECTED_FIELD' : 'INVALID_FIELD',
      }))),
    });
  }

  override async transform(value: unknown, metadata: ArgumentMetadata) {
    const allowed = metadata.type === 'body' ? ALLOWED_KEYS.get(metadata.metatype) : undefined;
    if (allowed) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidInput();
      }
      // Inspect raw keys before class-transformer can discard prototype-related
      // keys, and reject nested values before recursively transforming them.
      const fields = Object.entries(value).flatMap(([key, item]) => {
        if (!allowed.includes(key)) return [{ field: 'body', code: 'UNEXPECTED_FIELD' }];
        return typeof item === 'string' ? [] : [{ field: key, code: 'INVALID_FIELD' }];
      });
      if (fields.length) throw invalidInput(fields);
      if (metadata.metatype === LogoutDto) return new LogoutDto();
    }
    return super.transform(value, metadata);
  }
}
