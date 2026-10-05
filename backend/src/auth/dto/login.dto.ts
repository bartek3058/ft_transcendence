import { Transform } from 'class-transformer';
import { IsAscii, IsEmail, IsString, Matches, MaxLength } from 'class-validator';
import { normalizeIdentity } from '../validation/input-rules';
import { IsPassword } from '../validation/password.decorator';

export class LoginDto {
  @Transform(({ value }) => normalizeIdentity(value))
  @IsString()
  @IsAscii()
  @MaxLength(254)
  @Matches(/^\S+$/)
  @IsEmail({ allow_utf8_local_part: false, allow_display_name: false })
  email!: string;

  @IsPassword(1)
  password!: string;
}
