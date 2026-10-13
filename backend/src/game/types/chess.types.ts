export type PlayerColor = 'w' | 'b';
export type PromotionPiece = 'q' | 'r' | 'b' | 'n'; // q -> queen, r -> rock, b -> bishop, n -> knight
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