import { Chess } from 'chess.js';
export type PlayerColor = 'w' | 'b';
export type DatabaseMoveColor = 'WHITE' | 'BLACK';
export type PromotionPiece = 'q' | 'r' | 'b' | 'n'; // q -> queen, r -> rock, b -> bishop, n -> knight
export type DatabaseGameResult =
  | 'WHITE_WON'
  | 'BLACK_WON'
  | 'DRAW'
  | 'IN_PROGRESS'
  | 'ABORTED';
// tszyman for match history, Alaxea for ranking/ELO
export type GameOverReason =
| 'CHECKMATE'
| 'STALEMATE'
| 'INSUFFICIENT_MATERIAL'
| 'THREEFOLD_REPETITATION'
| 'FIFTY_MOVE_RULE'
| 'TIMEOUT'
| 'RESIGNATION'
| 'ABANDONMENT';

export interface MoveExecutionResult
{
    // Indicates whether the move was legally verified and applied.
    success: boolean;
    // FEN representation after move or resynchronize the client if the move failed.
    currentFen: string;
    //Explicit failure code if success is false
    errorReason?:
    | 'UNAUTHENTICATED'
    | 'UNAUTHORIZED_PLAYER'
    | 'NOT_YOUR_TURN'
    | 'ILLEGAL_MOVE'
    | 'GAME_NOT_FOUND'
    | 'GAME_ALREADY_FINISHED';
    //standard algebraic notation representation (e.g. 'e4')
    san?: string;
    isCheck?: boolean;
    isGameOver?: boolean;
    //detailed reason why the game ended or null if still ongoing
    gameOverReason?: GameOverReason | null;
    winnerColor?: PlayerColor | null;
}

export interface CreateGameOptions 
{
    gameId: string;
    whitePlayerId: string;
    blackPlayerId: string;
    initialTimeMs?: number;
    timeControl?: string;
    initialFen?: string;
}

/**
 * [INTEGRATION - EXPOSED API for @tszyman (Database #64 / Move History #88)]
 * Represents a verified move waiting in the asynchronous Cold-Path RAM buffer
 * before being persisted to PostgreSQL and purged from memory.
 */

export interface PendingMoveRecord
{
    gameId: string;
    ply: number;
    moveNumber: number;
    color: DatabaseMoveColor;
    playedById: string;
    san: string;
    uci: string;
    fenAfter: string;
    timeSpentMs: number;
    timeRemainingMs: number;
    createdAt: Date;
}

/**
 * Internal authoritative representation of a live match stored in server RAM (Task #120).
 */

export interface GameSession
{
    gameId: string;
    engine: Chess;
    whitePlayerId: string;
    blackPlayerId: string;
    whiteTimeRemainingMs: number;
    blackTimeRemainingMs: number;
    timeControl: string | null;
    lastMoveTimestamp: number;
    plyCount: number;
    isFinished: boolean;
    winnerColor: PlayerColor | null;
    gameOverReason: GameOverReason | null;
    createdAt: number;
}

/**
 * [INTEGRATION - EXPOSED API for @piomam21 (Gameplay #92 / Reconnections #121)]
 * Read-only, serializable snapshot of a game session safe to send over WebSockets.
 * Prevents external modules from directly mutating the internal chess.js instance.
 */

export interface PublicGameState
{
    gameId: string;
    fen: string;
    turn: PlayerColor;
    whitePlayerId: string;
    blackPlayerId: string;
    whiteTimeRemainingMs: number;
    blackTimeRemainingMs: number;
    timeControl: string | null;
    plyCount: number;
    moveNumber: number;
    isCheck: boolean;
    isFinished: boolean;
    winnerColor: PlayerColor | null;
    gameOverReason: GameOverReason | null;
}

// (Hot-Path) if aithorized is false, 'rejectionResult' contains a ready-to-send 'MoveExecutionResult'
// with the authoritative 'currentFen' for client resynchronization
export interface MoveAuthorizationResult
{
    authorized: boolean;
    session?: GameSession;
    playerColor?: PlayerColor;
    playerId?: string;
    rejectionResult?: MoveExecutionResult;
}