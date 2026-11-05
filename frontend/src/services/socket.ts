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

export interface MatchFound {
  gameId: string;
  whitePlayerId: string;
  blackPlayerId: string;
  timeControl: string | null;
  state: PublicGameState;
}

export interface GameJoined {
  gameId: string;
  color: PlayerColor;
  state: PublicGameState;
}

let matchmakingSocket: Socket | null = null;
let gameSocket: Socket | null = null;

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

export function joinGameRoom(gameId: string): void {
  const socket = getGameSocket();
  const join = () => socket.emit("game:join", { gameId });

  if (socket.connected) {
    join();
  } else {
    socket.once("game:ready", join);
    socket.connect();
  }
}

export function disconnectRealtime(): void {
  matchmakingSocket?.disconnect();
  gameSocket?.disconnect();
}
