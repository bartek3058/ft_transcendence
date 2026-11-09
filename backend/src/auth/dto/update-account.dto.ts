import { Transform } from 'class-transformer';
import { IsString } from 'class-validator';
import { IsDisplayNameOrEmpty, normalizeDisplayName } from '../validation/display-name';

export class UpdateAccountDto {
  // "" clears it, then the username is shown again
  @Transform(({ value }) => normalizeDisplayName(value))
  @IsString()
  @IsDisplayNameOrEmpty()
  displayName!: string;
}
