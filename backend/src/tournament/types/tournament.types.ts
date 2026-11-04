export const VALID_TOURNAMENT_SIZES = [2, 4, 8, 16, 32] as const;
export type TournamentSize = (typeof VALID_TOURNAMENT_SIZES)[number];

export const TOURNAMENT_STATUSES = [
  'OPEN_FOR_SIGNUP',
  'REGISTRATION_CLOSED',
  'IN_PROGRESS',
  'FINISHED',
  'CANCELLED',
] as const;
export type TournamentStatus = (typeof TOURNAMENT_STATUSES)[number];

export const TOURNAMENT_MATCH_STATUSES = [
  'PENDING',
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'WALKOVER',
] as const;
export type TournamentMatchStatus = (typeof TOURNAMENT_MATCH_STATUSES)[number];

export const INVITATION_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export interface TournamentPlayerProfile {
  id: string;
  username: string;
  rating: number;
}

export interface TournamentParticipantDto {
  id: string;
  tournamentId: string;
  userId: string;
  seed: number | null;
  finalRank: number | null;
  registeredAt: Date;
  user?: TournamentPlayerProfile;
}

export interface TournamentMatchDto {
  id: string;
  tournamentId: string;
  round: number;
  matchIndex: number;
  identifier: string; // e.g., "R1-M1"
  player1Id: string | null;
  player2Id: string | null;
  winnerId: string | null;
  status: TournamentMatchStatus;
  isBye: boolean;
  sourceMatch1Id: string | null;
  sourceMatch2Id: string | null;
  nextMatchId: string | null;
  nextMatchSlot: 'player1' | 'player2' | null;
  gameId?: string | null;
  player1?: TournamentPlayerProfile | null;
  player2?: TournamentPlayerProfile | null;
  winner?: TournamentPlayerProfile | null;
}

export interface TournamentPublicDto {
  id: string;
  title: string;
  description: string | null;
  creatorId: string;
  maxParticipants: number;
  currentParticipants: number;
  status: TournamentStatus;
  registrationDeadline: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  championId: string | null;
  createdAt: Date;
  creator?: TournamentPlayerProfile;
  champion?: TournamentPlayerProfile | null;
}

export interface TournamentDetailDto extends TournamentPublicDto {
  participants: TournamentParticipantDto[];
  matches: TournamentMatchDto[];
}

export interface TournamentInvitationDto {
  id: string;
  tournamentId: string;
  senderId: string;
  recipientId: string;
  status: InvitationStatus;
  createdAt: Date;
  expiresAt: Date;
  tournament?: {
    id: string;
    title: string;
    maxParticipants: number;
    currentParticipants: number;
    registrationDeadline: Date;
  };
  sender?: TournamentPlayerProfile;
  recipient?: TournamentPlayerProfile;
}
