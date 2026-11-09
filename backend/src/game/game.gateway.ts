import { OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketServer,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MakeMoveDto } from './dto/make-move.dto';
import { SessionService } from '../auth/session.service';
import { readSessionToken } from '../auth/session-cookie';
import { GameService } from './game.service';

interface JoinGameRoomDto {
  gameId?: string;
}

@WebSocketGateway({ namespace: '/game' })
export class GameGateway implements OnGatewayConnection, OnGatewayInit, OnModuleDestroy {
  private clockTimer: NodeJS.Timeout | null = null;
  private lastClockBroadcast = 0;
  private readonly concludingGames = new Set<string>();
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly sessions: SessionService,
    private readonly game: GameService,
  ) {}

  onModuleDestroy(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
  }

  afterInit(): void {
    // One timer per gateway, not one per game or connected client.
    this.clockTimer = setInterval(() => {
      const now = Date.now();
      const shouldBroadcast = now - this.lastClockBroadcast >= 5000;
      if (shouldBroadcast) this.lastClockBroadcast = now;
      for (const gameId of this.game.getActiveGameIds()) {
        if (this.concludingGames.has(gameId)) continue;
        if (this.game.checkGameTimeout(gameId, now)) {
          void this.finishTimedOutGame(gameId);
          continue;
        }
        if (shouldBroadcast) {
          const snapshot = this.game.getClockSnapshot(gameId, now);
          if (snapshot && !snapshot.isFinished) {
            this.server.to(gameId).emit('game:clock', snapshot);
          }
        }
      }
    }, 250);
    this.clockTimer.unref();
  }

  private async finishTimedOutGame(gameId: string): Promise<void> {
    await this.concludeGame(gameId, true);
  }

   //Finished and saves a end game (DB, Elo, tournaments) and clears it from RAM.
   // Shared by timeouts and board finishes, with a guard to prevent double saves.
  private async concludeGame(gameId: string, broadcastState: boolean): Promise<void> {
    if (this.concludingGames.has(gameId)) return;
    this.concludingGames.add(gameId);
    try {
      if (!this.game.hasActiveGame(gameId)) return;
      if (broadcastState) {
        this.server.to(gameId).emit('game:state', this.game.getPublicGameState(gameId));
      }
      await this.game.removeGame(gameId);
    } finally {
      this.concludingGames.delete(gameId);
    }
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = readSessionToken({
        headers: {
          cookie: client.handshake.headers.cookie,
        },
      });

      const account = await this.sessions.authenticate(token);

      client.data.userId = account.id;

      // The client must wait until authentication has completed
      // before sending game:join.
      client.emit('game:ready');
    } catch {
      client.emit('game:error', {
        code: 'UNAUTHENTICATED',
      });

      client.disconnect(true);
    }
  }

  // Discover an ongoing match using the authenticated server-side identity.
  // Never trust a player ID supplied by the browser.
  @SubscribeMessage('game:resume')
  async handleResume(@ConnectedSocket() client: Socket): Promise<void> {
    const userId: string | undefined = client.data.userId;
    if (!userId) {
      client.emit('game:error', { code: 'UNAUTHENTICATED' });
      return;
    }
    const gameId = this.game.findActiveGameForPlayer(userId);
    if (!gameId) {
      client.emit('game:no-active');
      return;
    }
    await this.handleJoinRoom(client, { gameId });
  }

  @SubscribeMessage('game:join')
  async handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinGameRoomDto,
  ): Promise<void> {
    const userId: string | undefined = client.data.userId;

    if (!userId) {
      client.emit('game:error', {
        code: 'UNAUTHENTICATED',
      });

      client.disconnect(true);
      return;
    }

    const gameId = dto?.gameId?.trim();

    if (!gameId) {
      client.emit('game:error', {
        code: 'GAME_ID_REQUIRED',
      });

      return;
    }

    const session = this.game.getGameSession(gameId);

    if (!session) {
      // The game may have finished while this client was disconnected.
      // Only its participants may retrieve the result.
      try {
        const finished = await this.game.getFinishedGameForPlayer(gameId, userId);
        if (finished) {
          client.emit('game:finished', finished);
          return;
        }
      } catch {
        client.emit('game:error', { code: 'GAME_RESULT_LOOKUP_FAILED' });
        return;
      }
      client.emit('game:error', { code: 'GAME_NOT_FOUND' });
      return;
    }

    if (
      session.whitePlayerId !== userId &&
      session.blackPlayerId !== userId
    ) {
      client.emit('game:error', {
        code: 'NOT_A_PLAYER',
      });

      return;
    }

    await client.join(gameId);

    // Include elapsed time since the last move, not the stored base clock.
    const state = this.game.getPublicGameState(gameId);
    const clock = this.game.getClockSnapshot(gameId);
    if (clock) {
      state.whiteTimeRemainingMs = clock.whiteTimeRemainingMs;
      state.blackTimeRemainingMs = clock.blackTimeRemainingMs;
    }

    client.emit('game:joined', {
      gameId,
      color: session.whitePlayerId === userId ? 'w' : 'b',
      state,
    });
  }


  @SubscribeMessage('game:move')
  handleMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: MakeMoveDto,
  ): void {
    const userId: string | undefined = client.data.userId;
    if (!userId) {
      client.emit('game:error', { code: 'UNAUTHENTICATED' });
      return;
    }

    if (
      !dto || typeof dto.gameId !== 'string' ||
      !/^[a-h][1-8]$/.test(dto.from) ||
      !/^[a-h][1-8]$/.test(dto.to) ||
      (dto.promotion !== undefined && !['q', 'r', 'b', 'n'].includes(dto.promotion))
    ) {
      client.emit('game:error', { code: 'INVALID_MOVE' });
      return;
    }

    if (!client.rooms.has(dto.gameId)) {
      client.emit('game:error', { code: 'NOT_IN_ROOM' });
      return;
    }

    const result = this.game.executeMove(dto, userId);
    if (!result.success) {
      if (result.errorReason === 'TIMEOUT') {
        void this.finishTimedOutGame(dto.gameId);
      }
      client.emit('game:error', {
        code: result.errorReason ?? 'ILLEGAL_MOVE',
        state: this.game.hasActiveGame(dto.gameId)
          ? this.game.getPublicGameState(dto.gameId)
          : undefined,
      });
      return;
    }

    this.server.to(dto.gameId).emit('game:state',
      this.game.getPublicGameState(dto.gameId));

    if (result.isGameOver) {
      void this.concludeGame(dto.gameId, false);
    }
  }

  @SubscribeMessage('game:leave')
  async handleLeaveRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinGameRoomDto,
  ): Promise<void> {
    if (typeof dto?.gameId === 'string') {
      await client.leave(dto.gameId);
    }
  }

  @SubscribeMessage('game:resign')
  async handleResign(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinGameRoomDto,
  ): Promise<{ success: boolean; code?: string }> {
    const userId: string | undefined = client.data.userId;
    if (!userId) {
      return { success: false, code: 'UNAUTHENTICATED' };
    }

    const gameId = typeof dto?.gameId === 'string' ? dto.gameId.trim() : '';
    if (!gameId) {
      return { success: false, code: 'GAME_ID_REQUIRED' };
    }
    if (!client.rooms.has(gameId)) {
      return { success: false, code: 'NOT_IN_ROOM' };
    }

    const result = this.game.resignGame(gameId, userId);
    if (!result.success) {
      return { success: false, code: result.errorReason ?? 'RESIGN_FAILED' };
    }

    // Deliver the final state before removeGame purges the in-memory session.
    this.server.to(gameId).emit('game:state', this.game.getPublicGameState(gameId));

    // Persist result, moves and rating using the existing conclusion pipeline.
    const saved = await this.game.removeGame(gameId);
    if (!saved) {
      return { success: false, code: 'GAME_RESULT_SAVE_FAILED' };
    }
    return { success: true };
  }

}
