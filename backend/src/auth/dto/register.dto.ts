import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { LoginDto } from './login.dto';
import { normalizeUsername, PASSWORD_MIN_LENGTH, USERNAME_PATTERN } from '../validation/input-rules';
import { IsPassword } from '../validation/password.decorator';

export class RegisterDto extends LoginDto {
  @Transform(({ value }) => normalizeUsername(value))
  @IsString()
  @Matches(USERNAME_PATTERN)
  username!: string;

  @IsPassword(PASSWORD_MIN_LENGTH)
  password!: string;
}
