import { ArgumentMetadata, BadRequestException, Injectable, ValidationPipe } from '@nestjs/common';
import { LoginDto } from '../dto/login.dto';
import { RegisterDto } from '../dto/register.dto';
import { LogoutDto } from '../dto/logout.dto';

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
        field: ['email', 'username', 'password'].includes(error.property) ? error.property : 'body',
        code: error.constraints?.whitelistValidation ? 'UNEXPECTED_FIELD' : 'INVALID_FIELD',
      }))),
    });
  }

  override async transform(value: unknown, metadata: ArgumentMetadata) {
    if (metadata.type === 'body'
      && [LoginDto, RegisterDto, LogoutDto].includes(metadata.metatype)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidInput();
      }
      const allowed = metadata.metatype === RegisterDto
        ? ['email', 'username', 'password'] : metadata.metatype === LogoutDto ? [] : ['email', 'password'];
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
