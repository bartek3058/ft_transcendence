import { IsString, Matches, IsOptional, IsIn } from 'class-validator'
import { PromotionPiece } from '../types/chess.types';
//Data transfer Object (DTO) validating incoming 'make_move' WebSocket payload.
// Malformed or malicious payloads are rejected before reaching in-memory state
export class MakeMoveDto {
    @IsString({ message: 'gameId must be a valid string' })
    gameId: string;

    //Starting square coordinate in standard algebraic format (1-8), (a-h)
    @Matches(/^[a-h][1-8]$/, {
    message: 'Field "from" must be a valid chess coordinate (e.g., e2, g1)',
    })
    from: string;

    //same for destination coordinate
    @Matches(/^[a-h][1-8]$/, {
    message: 'Field "to" must be a valid chess coordinate (e.g., e4, f3)',
    })
    to: string;

    // optional for promotion
    @IsOptional()
    @IsIn(['q', 'r', 'b', 'n'], {
    message: 'Field "promotion" must be one of: q (queen), r (rook), b (bishop), n (knight)',
    })
    promotion?: PromotionPiece;
}