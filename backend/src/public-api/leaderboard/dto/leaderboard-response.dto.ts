import { ApiProperty } from '@nestjs/swagger';

export class LeaderboardItemDto {
  @ApiProperty({ example: 1, description: 'Global ranking position' })
  rank!: number;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'Unique user UUID' })
  userId!: string;

  @ApiProperty({ example: 'grandmaster_bob', description: 'Player username' })
  username!: string;

  @ApiProperty({ example: 1850, description: 'Current ELO rating' })
  rating!: number;

  @ApiProperty({ example: 42, description: 'Total finished rated matches' })
  gamesPlayed!: number;

  @ApiProperty({ example: 25, description: 'Total wins' })
  wins!: number;

  @ApiProperty({ example: 10, description: 'Total losses' })
  losses!: number;

  @ApiProperty({ example: 7, description: 'Total draws' })
  draws!: number;

  @ApiProperty({ example: 59.5, description: 'Win percentage (0-100)' })
  winRate!: number;
}

export class PaginatedLeaderboardDto {
  @ApiProperty({ example: 1, description: 'Current page number' })
  page!: number;

  @ApiProperty({ example: 20, description: 'Items per page' })
  limit!: number;

  @ApiProperty({ example: 120, description: 'Total number of players' })
  total!: number;

  @ApiProperty({ example: 6, description: 'Total number of pages' })
  totalPages!: number;

  @ApiProperty({ type: [LeaderboardItemDto], description: 'Ranked players on this page' })
  items!: LeaderboardItemDto[];
}

export class TopPlayerDto {
  @ApiProperty({ example: 'grandmaster_bob', description: 'Username of rank #1 player' })
  username!: string;

  @ApiProperty({ example: 2150, description: 'Rating of rank #1 player' })
  rating!: number;
}

export class GlobalStatsDto {
  @ApiProperty({ example: 150, description: 'Total registered players on the platform' })
  totalPlayers!: number;

  @ApiProperty({ example: 580, description: 'Total completed rated matches' })
  totalMatches!: number;

  @ApiProperty({ example: 1245, description: 'Average ELO rating across active players' })
  averageRating!: number;

  @ApiProperty({ example: 2150, description: 'Highest recorded ELO rating' })
  highestRating!: number;

  @ApiProperty({ type: TopPlayerDto, nullable: true, description: 'Current rank #1 player' })
  topPlayer!: TopPlayerDto | null;
}

export class PlayerRankingDto {
  @ApiProperty({ example: 3, description: 'Global ranking position' })
  rank!: number;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'User UUID' })
  userId!: string;

  @ApiProperty({ example: 'chess_wizard', description: 'Player username' })
  username!: string;

  @ApiProperty({ example: 1680, description: 'Current ELO rating' })
  rating!: number;

  @ApiProperty({ example: 30, description: 'Total finished matches' })
  gamesPlayed!: number;

  @ApiProperty({ example: 18, description: 'Total wins' })
  wins!: number;

  @ApiProperty({ example: 8, description: 'Total losses' })
  losses!: number;

  @ApiProperty({ example: 4, description: 'Total draws' })
  draws!: number;

  @ApiProperty({ example: 60.0, description: 'Win percentage (0-100)' })
  winRate!: number;
}
