import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { PrismaService } from '../database/prisma.service';
import { SessionService } from '../auth/session.service';
import { readSessionToken } from '../auth/session-cookie';
import { MatchmakingService } from './matchmaking.service';
import { JoinQueueDto } from './dto/join-queue.dto';

@WebSocketGateway({ namespace: '/matchmaking' })
export class MatchmakingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(MatchmakingGateway.name);

  private readonly sockets = new Map<string, Socket>();

  constructor(
    private readonly sessions: SessionService,
    private readonly matchmaking: MatchmakingService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = readSessionToken({
        headers: {
          cookie: client.handshake.headers.cookie,
        },
      });

      const account = await this.sessions.authenticate(token);

      client.data.userId = account.id;
      this.sockets.set(account.id, client);

      client.emit('matchmaking:ready');
    } catch {
      client.emit('error', {
        code: 'UNAUTHENTICATED',
      });

      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    const userId: string | undefined = client.data.userId;

    if (!userId) {
      return;
    }

    this.matchmaking.leave(userId);

    if (this.sockets.get(userId) === client) {
      this.sockets.delete(userId);
    }
  }

  @SubscribeMessage('queue:join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinQueueDto,
  ): Promise<void> {
    const userId: string | undefined = client.data.userId;

    if (!userId) {
      client.emit('error', {
        code: 'UNAUTHENTICATED',
      });

      client.disconnect(true);
      return;
    }

    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        rating: true,
      },
    });

    if (!user) {
      client.emit('error', {
        code: 'USER_NOT_FOUND',
      });

      return;
    }

    this.matchmaking.join({
      userId,
      rating: user.rating,
      timeControl: dto?.timeControl,
    });

    client.emit('queue:joined', {
      timeControl: dto?.timeControl ?? null,
    });

    const matches = await this.matchmaking.matchAll();

    for (const match of matches) {
      for (const playerId of match.players) {
        this.sockets.get(playerId)?.emit('matched', {
          gameId: match.gameId,
          whitePlayerId: match.whitePlayerId,
          blackPlayerId: match.blackPlayerId,
          timeControl: match.timeControl ?? null,
          state: match.state,
        });
      }
    }
  }

  @SubscribeMessage('queue:leave')
  handleLeave(@ConnectedSocket() client: Socket): void {
    const userId: string | undefined = client.data.userId;

    if (userId) {
      this.matchmaking.leave(userId);
    }

    client.emit('queue:left', {});
  }
}