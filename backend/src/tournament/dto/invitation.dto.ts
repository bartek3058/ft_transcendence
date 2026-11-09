import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class CreateInvitationDto {
  // lowercase so it matches the stored friendship ids
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsString()
  @Matches(UUID)
  recipientId!: string;
}

export const INVITATION_RESPONSES = ['ACCEPT', 'DECLINE'] as const;
export type InvitationResponse = (typeof INVITATION_RESPONSES)[number];

export class RespondInvitationDto {
  @IsIn(INVITATION_RESPONSES)
  response!: InvitationResponse;
}

export class InvitationsQueryDto {
  // a string on purpose, no implicit coercion of arrays or floats
  @IsOptional() @Matches(/^(?:[1-9]|[1-4][0-9]|50)$/) limit?: string;
  @IsOptional() @Matches(/^(?:0|[1-9][0-9]{0,3})$/) offset?: string;
}
