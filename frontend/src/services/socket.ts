import { io, type Socket } from "socket.io-client";

export type PlayerColor = "w" | "b";

export interface PublicGameState {
  gameId: string;
  fen: string;
  moves: string[];
  turn: PlayerColor;
  whitePlayerId: string;
  blackPlayerId: string;
  whiteTimeRemainingMs: number;
  blackTimeRemainingMs: number;
  timeControl: string | null;
  plyCount: number;
  moveNumber: number;
  isFinished: boolean;
  isCheck: boolean;
  winnerColor: PlayerColor | null;
  gameOverReason: string | null;
}

export interface GameClockSnapshot {
  gameId: string;
  whiteTimeRemainingMs: number;
  blackTimeRemainingMs: number;
  turn: PlayerColor;
  plyCount: number;
  isFinished: boolean;
}

export type AiDifficulty = "easy" | "medium" | "hard";

export interface AiMoveResult {
  success: boolean;
  currentFen: string;
  san?: string;
  uci?: string;
  isGameOver?: boolean;
  gameOverReason?: string | null;
  winnerColor?: PlayerColor | null;
  errorReason?: string;
}

export interface AiGameOver {
  winnerColor: PlayerColor | null;
  reason: string | null;
}

export interface AiCreated {
  gameId: string;
  humanColor: PlayerColor;
  botColor: PlayerColor;
  difficulty: AiDifficulty;
  state: PublicGameState;
}

export interface AiMoved {
  humanMove: AiMoveResult | null;
  botMove: AiMoveResult | null;
  botUci?: string;
  state: PublicGameState;
  gameOver: AiGameOver | null;
}

export interface AiHint {
  uci: string;
  from: string;
  to: string;
  promotion: "q" | "r" | "b" | "n" | null;
  evaluation: {
    scoreCp: number | null;
    mateIn: number | null;
    depth: number | null;
  };
}

export interface MatchFound {
  gameId: string;
  whitePlayerId: string;
  blackPlayerId: string;
  timeControl: string | null;
  state: PublicGameState;
}

export interface FinishedGame {
  gameId: string;
  winnerColor: PlayerColor | null;
  reason: string | null;
  result: string;
}

export interface GameJoined {
  gameId: string;
  color: PlayerColor;
  state: PublicGameState;
  whiteUsername?: string | null;
  blackUsername?: string | null;
  whiteRating?: number | null;
  blackRating?: number | null;
}

let matchmakingSocket: Socket | null = null;
let gameSocket: Socket | null = null;
let aiGameSocket: Socket | null = null;

export function getMatchmakingSocket(): Socket {
  if (!matchmakingSocket) {
    matchmakingSocket = io("/matchmaking", {
      autoConnect: false,
      transports: ["websocket", "polling"],
    });
  }
  return matchmakingSocket;
}

export function getGameSocket(): Socket {
  if (!gameSocket) {
    gameSocket = io("/game", {
      autoConnect: false,
      transports: ["websocket", "polling"],
    });
  }

  return gameSocket;
}

export function getAiGameSocket(): Socket {
  if (!aiGameSocket) {
    aiGameSocket = io("/ai-game", {
      autoConnect: false,
      transports: ["websocket", "polling"],
    });
  }
  return aiGameSocket;
}

export function joinGameRoom(gameId: string): void {
  getGameSocket().emit("game:join", { gameId });
}

export function disconnectRealtime(): void {
  matchmakingSocket?.disconnect();
  gameSocket?.disconnect();
  aiGameSocket?.disconnect();
}
