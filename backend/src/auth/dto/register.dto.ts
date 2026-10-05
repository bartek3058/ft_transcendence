import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { LoginDto } from './login.dto';
import { normalizeIdentity, PASSWORD_MIN_LENGTH } from '../validation/input-rules';
import { IsPassword } from '../validation/password.decorator';

export class RegisterDto extends LoginDto {
  @Transform(({ value }) => normalizeIdentity(value))
  @IsString()
  @Matches(/^[a-z0-9_]{3,20}$/)
  username!: string;

  @IsPassword(PASSWORD_MIN_LENGTH)
  password!: string;
}
