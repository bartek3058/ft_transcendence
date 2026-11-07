import { TournamentMatchSlot, TournamentMatchStatus, TournamentStatus } from './tournament.types';

// HTTP response shapes. Players carry only id + username: live users.rating is never
// exposed; the only rating in a response is the frozen participant seedRating.

export interface TournamentUserRef {
  id: string;
  username: string;
}

export interface TournamentSummary {
  id: string;
  title: string;
  description: string | null;
  status: TournamentStatus;
  maxParticipants: number;
  currentParticipants: number;
  registrationDeadline: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  creator: TournamentUserRef;
  champion: TournamentUserRef | null;
}

export interface TournamentPage {
  items: TournamentSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface TournamentParticipantView {
  userId: string;
  username: string;
  seed: number | null;
  seedRating: number | null;
  finalRank: number | null;
  registeredAt: Date;
}

export interface TournamentMatchView {
  id: string;
  round: number;
  matchIndex: number;
  identifier: string;
  status: TournamentMatchStatus;
  isBye: boolean;
  player1: TournamentUserRef | null;
  player2: TournamentUserRef | null;
  winnerId: string | null;
  nextMatchId: string | null;
  nextMatchSlot: TournamentMatchSlot | null;
  gameIds: string[];
  currentGameId: string | null;
}

export interface TournamentDetail extends TournamentSummary {
  participants: TournamentParticipantView[];
  matches: TournamentMatchView[];
}

export interface RegistrationChange {
  currentParticipants: number;
}
