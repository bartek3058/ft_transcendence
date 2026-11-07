import { TournamentMatchSlot, TournamentMatchStatus } from '../types/tournament.types';

export interface ParticipantToSeed {
  userId: string;
  seedRating: number;
  registeredAt?: Date;
}

export interface SeededParticipant extends ParticipantToSeed {
  seed: number;
}

export interface GeneratedMatchNode {
  id: string; // Pre-generated UUID
  round: number;
  matchIndex: number;
  identifier: string; // e.g. "R1-M1"
  player1Id: string | null;
  player2Id: string | null;
  winnerId: string | null;
  status: TournamentMatchStatus;
  isBye: boolean;
  nextMatchId: string | null;
  nextMatchSlot: TournamentMatchSlot | null;
}

export interface GeneratedBracket {
  bracketSize: number;
  totalRounds: number;
  rounds: GeneratedMatchNode[][];
  matches: GeneratedMatchNode[]; // Flattened for bulk insert
  seededParticipants: SeededParticipant[];
}
