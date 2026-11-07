import { IsIn, IsOptional, Matches } from 'class-validator';
import { TOURNAMENT_TABS, TournamentTab } from '../tournament-rules';

export class ListTournamentsQueryDto {
  // Defaults to 'open' in the service. Repeated params arrive as arrays and fail IsIn.
  @IsOptional() @IsIn(TOURNAMENT_TABS) status?: TournamentTab;
  // Strings avoid implicit coercion of arrays, floats or malformed values (as in friends.dto).
  @IsOptional() @Matches(/^(?:[1-9]|[1-4][0-9]|50)$/) limit?: string;
  @IsOptional() @Matches(/^(?:0|[1-9][0-9]{0,3})$/) offset?: string;
}
