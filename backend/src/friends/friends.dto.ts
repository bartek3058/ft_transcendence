import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';

export class FriendRequestDto {
  @IsUUID() targetUserId!: string;
}
export class PageDto {
  // Strings avoid implicit coercion of arrays, floats, or malformed values.
  @IsOptional() @Matches(/^(?:[1-9]|[1-4][0-9]|50)$/) limit?: string;
  @IsOptional() @Matches(/^(?:0|[1-9][0-9]{0,3})$/) offset?: string;
}
export class SearchDto extends PageDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @Matches(/^[a-z0-9_]{3,20}$/) q!: string;
}
export class RequestsDto extends PageDto {
  @IsOptional() @IsIn(['incoming', 'outgoing']) direction?: string;
}
