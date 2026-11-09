import { TournamentMatchSlot, TournamentMatchStatus, TournamentStatus } from './tournament.types';

// Players only carry id, username and displayName, the only rating in a response is the frozen seedRating.

export interface TournamentUserRef {
  id: string;
  username: string;
  // null = not set, show the username
  displayName: string | null;
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
  displayName: string | null;
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
  checkInDeadline: Date | null;
  player1CheckedIn: boolean;
  player2CheckedIn: boolean;
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

export type InvitationStatusView = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED';

export interface InvitationCreated {
  invitationId: string;
  tournamentId: string;
  recipientId: string;
  status: 'PENDING';
  expiresAt: Date;
}

export interface MyInvitation {
  id: string;
  tournament: {
    id: string;
    title: string;
    status: TournamentStatus;
    maxParticipants: number;
    currentParticipants: number;
    registrationDeadline: Date;
  };
  sender: TournamentUserRef;
  createdAt: Date;
  expiresAt: Date;
}

export interface MyInvitationsPage {
  items: MyInvitation[];
  total: number;
  limit: number;
  offset: number;
}

export interface InvitationAnswer {
  invitationId: string;
  tournamentId: string;
  status: InvitationStatusView;
  // only after an accept
  currentParticipants?: number;
}
