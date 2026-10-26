import { IsOptional, IsString, Matches } from 'class-validator';

// Payload a client sends to join the matchmaking queue. The player's identity and rating
// are taken from the authenticated session + database, never from the request body.
export class JoinQueueDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-z]+_\d{1,3}_\d{1,3}$/, {
    message: 'timeControl must look like "blitz_5_0" (category_minutes_increment)',
  })
  timeControl?: string;
}
