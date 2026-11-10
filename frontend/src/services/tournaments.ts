import { api } from "./api";
import type {
  TournamentMatchSlot,
  TournamentMatchStatus,
  TournamentStatus,
} from "../types/tournament";

export type TournamentTab = "open" | "live" | "past";
export type TournamentSize = 2 | 4 | 8 | 16 | 32;

export interface TournamentUser {
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
  registrationDeadline: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  creator: TournamentUser;
  champion: TournamentUser | null;
}

export interface TournamentPage {
  items: TournamentSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface TournamentParticipant {
  userId: string;
  username: string;
  seed: number | null;
  seedRating: number | null;
  finalRank: number | null;
  registeredAt: string;
}

export interface TournamentMatch {
  id: string;
  round: number;
  matchIndex: number;
  identifier: string;
  status: TournamentMatchStatus;
  isBye: boolean;
  player1: TournamentUser | null;
  player2: TournamentUser | null;
  winnerId: string | null;
  nextMatchId: string | null;
  nextMatchSlot: TournamentMatchSlot | null;
  checkInDeadline: string | null;
  player1CheckedIn: boolean;
  player2CheckedIn: boolean;
  gameIds: string[];
  currentGameId: string | null;
}

export interface TournamentDetail extends TournamentSummary {
  participants: TournamentParticipant[];
  matches: TournamentMatch[];
}

export interface CreateTournamentInput {
  title: string;
  description?: string;
  maxParticipants: TournamentSize;
  registrationDeadline: string;
}

export function listTournaments(status: TournamentTab, offset = 0) {
  const params = new URLSearchParams({
    status,
    offset: String(offset),
  });

  return api<TournamentPage>(`/tournaments?${params.toString()}`);
}

export function getTournament(id: string) {
  return api<TournamentDetail>(`/tournaments/${encodeURIComponent(id)}`);
}

export function createTournament(input: CreateTournamentInput) {
  return api<TournamentSummary>("/tournaments", {
    method: "POST",
    headers: {
      "X-CSRF-Protection": "1",
    },
    body: JSON.stringify(input),
  });
}

export function joinTournament(id: string) {
  return api<{ currentParticipants: number }>(
    `/tournaments/${encodeURIComponent(id)}/join`,
    {
      method: "POST",
      headers: {
        "X-CSRF-Protection": "1",
      },
      body: "{}",
    },
  );
}

export function leaveTournament(id: string) {
  return api<{ currentParticipants: number }>(
    `/tournaments/${encodeURIComponent(id)}/leave`,
    {
      method: "POST",
      headers: {
        "X-CSRF-Protection": "1",
      },
      body: "{}",
    },
  );
}

export function closeTournamentRegistration(id: string) {
  return api<{
    status: "IN_PROGRESS" | "CANCELLED";
  }>(`/tournaments/${encodeURIComponent(id)}/close-registration`, {
    method: "POST",
    headers: {
      "X-CSRF-Protection": "1",
    },
    body: "{}",
  });
}

export function cancelTournament(id: string) {
  return api<{
    status: "CANCELLED";
  }>(`/tournaments/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    headers: {
      "X-CSRF-Protection": "1",
    },
    body: "{}",
  });
}

export function checkInTournamentMatch(
  tournamentId: string,
  matchId: string,
) {
  return api<{ gameId?: string }>(
    `/tournaments/${encodeURIComponent(tournamentId)}/matches/${encodeURIComponent(matchId)}/check-in`,
    {
      method: "POST",
      headers: { "X-CSRF-Protection": "1" },
      body: "{}",
    },
  );
}


export interface TournamentInvitation {
  id: string;
  tournament: {
    id: string;
    title: string;
    status: TournamentStatus;
    maxParticipants: number;
    currentParticipants: number;
    registrationDeadline: string;
  };
  sender: TournamentUser;
  createdAt: string;
  expiresAt: string;
}

export interface TournamentInvitationsPage {
  items: TournamentInvitation[];
  total: number;
  limit: number;
  offset: number;
}

export interface TournamentInvitationCreated {
  invitationId: string;
  tournamentId: string;
  recipientId: string;
  status: "PENDING";
  expiresAt: string;
}

export interface TournamentInvitationAnswer {
  invitationId: string;
  tournamentId: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED";
  currentParticipants?: number;
}

export function listMyTournamentInvitations(offset = 0, limit = 50) {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
  });
  return api<TournamentInvitationsPage>(
    `/tournaments/invitations/me?${params.toString()}`
  );
}

export function inviteToTournament(tournamentId: string, recipientId: string) {
  return api<TournamentInvitationCreated>(
    `/tournaments/${encodeURIComponent(tournamentId)}/invitations`,
    {
      method: "POST",
      headers: { "X-CSRF-Protection": "1" },
      body: JSON.stringify({ recipientId }),
    }
  );
}

export function respondToTournamentInvitation(
  invitationId: string,
  response: "ACCEPT" | "DECLINE"
) {
  return api<TournamentInvitationAnswer>(
    `/tournaments/invitations/${encodeURIComponent(invitationId)}/respond`,
    {
      method: "POST",
      headers: { "X-CSRF-Protection": "1" },
      body: JSON.stringify({ response }),
    }
  );
}
