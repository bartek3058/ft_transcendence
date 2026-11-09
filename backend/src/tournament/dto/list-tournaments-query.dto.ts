import { IsIn, IsOptional, Matches } from 'class-validator';
import { TOURNAMENT_TABS, TournamentTab } from '../tournament-rules';

export class ListTournamentsQueryDto {
  // defaults to 'open'; repeated params come as arrays and fail IsIn
  @IsOptional() @IsIn(TOURNAMENT_TABS) status?: TournamentTab;
  // a string on purpose, no implicit coercion of arrays or floats
  @IsOptional() @Matches(/^(?:[1-9]|[1-4][0-9]|50)$/) limit?: string;
  @IsOptional() @Matches(/^(?:0|[1-9][0-9]{0,3})$/) offset?: string;
}
