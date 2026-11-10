import { PASSWORD_MIN_LENGTH } from '../validation/input-rules';
import { IsPassword } from '../validation/password.decorator';

export class ChangePasswordDto {
  // no registration minimum here, older passwords may be shorter
  @IsPassword(1)
  currentPassword!: string;

  @IsPassword(PASSWORD_MIN_LENGTH)
  newPassword!: string;
}
