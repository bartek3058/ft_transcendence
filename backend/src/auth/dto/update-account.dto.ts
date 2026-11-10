import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { normalizeUsername, USERNAME_PATTERN } from '../validation/input-rules';

export class UpdateAccountDto {
  @Transform(({ value }) => normalizeUsername(value))
  @IsString()
  @Matches(USERNAME_PATTERN)
  username!: string;
}
