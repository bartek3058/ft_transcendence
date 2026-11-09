import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Socket } from 'socket.io';
import { SessionService } from '../auth/session.service';
import { readSessionToken } from '../auth/session-cookie';
import { GameService } from '../game/game.service';
import { PlayerColor, PromotionPiece } from '../game/types/chess.types';
import { AiGameService } from './ai-game.service';
import { AiDifficulty } from './ai.types';

interface NewAiGameDto {
  difficulty?: string;
  color?: string;
}

interface AiMoveDto {
  gameId?: string;
  from?: string;
  to?: string;
  promotion?: string;
}

interface AiResignDto {
  gameId?: string;
}

interface AiHintDto {
  gameId?: string;
}

/*
Transport for human-vs-AI games. Thin on purpose: it authenticates the socket,
then hands every request to AiGameService (which owns the game logic and the
engine) and relays the result back to the client.
Only the human connects here, so results go straight to the requesting socket.
*/
@WebSocketGateway({ namespace: '/ai-game' })
export class AiGameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AiGameGateway.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly game: GameService,
    private readonly aiGame: AiGameService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = readSessionToken({ headers: { cookie: client.handshake.headers.cookie } });
      const account = await this.sessions.authenticate(token);
      client.data.userId = account.id;
      client.emit('ai:ready');
    } catch {
      client.emit('ai:error', { code: 'UNAUTHENTICATED' });
      client.disconnect(true);
    }
  }

  @SubscribeMessage('ai:new')
  async handleNew(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: NewAiGameDto,
  ): Promise<void> {
    const userId: string | undefined = client.data.userId;
    if (!userId) {
      client.emit('ai:error', { code: 'UNAUTHENTICATED' });
      client.disconnect(true);
      return;
    }

    try {
      // Starting a new game abandons any previous one on this socket.
      const previous: string | undefined = client.data.aiGameId;
      if (previous) {
        await this.aiGame.abort(previous).catch(() => undefined);
        client.data.aiGameId = null;
      }

      const created = await this.aiGame.createAiGame({
        humanId: userId,
        difficulty: dto?.difficulty as AiDifficulty,
        humanColor: this.toColor(dto?.color),
      });
      await client.join(created.gameId);
      // Remember the active game on the socket
      client.data.aiGameId = created.gameId;
      client.emit('ai:created', {
        gameId: created.gameId,
        humanColor: created.humanColor,
        botColor: created.botColor,
        difficulty: created.difficulty,
        state: created.state,
      });

      // If the bot plays white it moves first; play that opening move now.
      const opening = await this.aiGame.playBotMoveIfDue(created.gameId);
      if (opening?.result.success) {
        client.emit('ai:moved', {
          humanMove: null,
          botMove: opening.result,
          botUci: opening.uci,
          evaluation: opening.evaluation,
          state: this.game.getPublicGameState(created.gameId),
          gameOver: null,
        });
      }
    } catch (error) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('ai:move')
  async handleMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: AiMoveDto,
  ): Promise<void> {
    const userId: string | undefined = client.data.userId;
    if (!userId) {
      client.emit('ai:error', { code: 'UNAUTHENTICATED' });
      client.disconnect(true);
      return;
    }

    const gameId = dto?.gameId?.trim();
    if (!gameId || !dto?.from || !dto?.to) {
      client.emit('ai:error', { code: 'BAD_REQUEST', message: 'gameId, from and to are required.' });
      return;
    }

    try {
      const turn = await this.aiGame.submitHumanMove(gameId, userId, {
        from: dto.from,
        to: dto.to,
        promotion: dto.promotion as PromotionPiece | undefined,
      });

      if (!turn.humanMove.success) {
        client.emit('ai:rejected', {
          reason: turn.humanMove.errorReason,
          state: turn.state,
        });
        return;
      }

      client.emit('ai:moved', {
        humanMove: turn.humanMove,
        botMove: turn.botMove,
        state: turn.state,
        gameOver: turn.gameOver,
      });
      if (turn.gameOver) {
        client.data.aiGameId = null;
        client.emit('ai:gameover', { ...turn.gameOver, state: turn.state });
      } else if (turn.botError) {
        /* Human move landed but the engine couldn't reply: tell the client so it
        doesn't sit locked on the bot's turn forever.*/
        client.emit('ai:error', {
          code: 'AI_MOVE_FAILED',
          message: 'The AI could not make a move. Please start a new game.',
        });
      }
    } catch (error) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('ai:resign')
  async handleResign(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: AiResignDto,
  ): Promise<void> {
    const userId: string | undefined = client.data.userId;
    if (!userId) {
      client.emit('ai:error', { code: 'UNAUTHENTICATED' });
      client.disconnect(true);
      return;
    }
    const gameId = dto?.gameId?.trim();
    if (!gameId) {
      client.emit('ai:error', { code: 'BAD_REQUEST', message: 'gameId is required.' });
      return;
    }

    try {
      const { state, gameOver } = await this.aiGame.resign(gameId, userId);
      client.data.aiGameId = null;
      client.emit('ai:gameover', { ...gameOver, state });
    } catch (error) {
      this.emitError(client, error);
    }
  }

  /* The player left the game (closed the board/"New game") without finishing.
  Abandon it so it does not linger in memory or as an IN_PROGRESS row.*/
  @SubscribeMessage('ai:leave')
  async handleLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: AiResignDto,
  ): Promise<void> {
    const gameId = dto?.gameId?.trim() || client.data.aiGameId;
    if (!gameId) {
      return;
    }
    client.data.aiGameId = null;
    await this.aiGame.abort(gameId).catch(() => undefined);
  }

  // Tab closed/connection dropped mid-game: abort the active game, if any.
  async handleDisconnect(client: Socket): Promise<void> {
    const gameId: string | undefined = client.data.aiGameId;
    if (gameId) {
      client.data.aiGameId = null;
      await this.aiGame.abort(gameId).catch(() => undefined);
    }
  }

  @SubscribeMessage('ai:hint')
  async handleHint(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: AiHintDto,
  ): Promise<void> {
    const userId: string | undefined = client.data.userId;
    if (!userId) {
      client.emit('ai:error', { code: 'UNAUTHENTICATED' });
      client.disconnect(true);
      return;
    }
    const gameId = dto?.gameId?.trim();
    if (!gameId) {
      client.emit('ai:error', { code: 'BAD_REQUEST', message: 'gameId is required.' });
      return;
    }

    try {
      const hint = await this.aiGame.hint(gameId, userId);
      client.emit('ai:hint', hint);
    } catch (error) {
      this.emitError(client, error);
    }
  }

  private toColor(value: string | undefined): PlayerColor | undefined {
    return value === 'w' || value === 'b' ? value : undefined;
  }

  private emitError(client: Socket, error: unknown): void {
    const message = error instanceof Error ? error.message : 'Unexpected AI game error.';
    this.logger.warn(`AI game error for user ${client.data.userId}: ${message}`);
    client.emit('ai:error', { code: 'AI_ERROR', message });
  }
}
