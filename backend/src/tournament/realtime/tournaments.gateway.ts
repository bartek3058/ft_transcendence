import { Inject, Logger, OnModuleDestroy, UnauthorizedException } from '@nestjs/common';
import {
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { AUTH_CONFIG, AuthConfig } from '../../auth/auth.config';
import { hashSessionToken, readSessionToken } from '../../auth/session-cookie';
import { SessionService } from '../../auth/session.service';
import { TournamentRateLimiter } from '../http/tournament-rate-limiter';
import { TournamentEventsPublisher } from '../tournament-events.publisher';
import { TournamentRealtimePayloads } from './tournament-realtime.payloads';

export const REALTIME_LIMITS = Object.freeze({
  connectsPerIp: 60, // per minute
  subscribesPerUser: 30, // per minute
  windowMs: 60_000,
  roomsPerSocket: 20,
  socketsPerUser: 10,
  socketsTotal: 10_000,
  sessionCheckMs: 15_000,
});

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const tournamentRoom = (id: string) => `tournament:${id}`;
export const userRoom = (id: string) => `user:${id}`;

type Ack = { ok: true } | { ok: false; error: { code: string } };
const ok: Ack = { ok: true };
const fail = (code: string): Ack => ({ ok: false, error: { code } });

interface Connection {
  client: Socket;
  userId: string;
  token: string;
  hash: string;
  rooms: Set<string>;
}

// Live tournament updates (#168). Server -> client only, after a reconnect the client
// reloads over REST.
@WebSocketGateway({ namespace: '/tournaments' })
export class TournamentsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(TournamentsGateway.name);
  private readonly live = new Map<string, Connection>();
  private readonly unsubscribe: (() => void)[] = [];
  private namespace?: Namespace;
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(private readonly sessions: SessionService,
    private readonly limiter: TournamentRateLimiter,
    private readonly payloads: TournamentRealtimePayloads,
    private readonly events: TournamentEventsPublisher,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  private readonly revoked = (hash: string) => {
    for (const entry of [...this.live.values()]) if (entry.hash === hash) this.drop(entry);
  };

  afterInit(namespace: Namespace): void {
    this.namespace = namespace;
    namespace.use(async (client, next) => {
      try {
        if (client.handshake.headers.origin !== this.config.origin || client.handshake.auth?.csrf !== '1') {
          throw new Error('origin');
        }
        this.limiter.consume(`tournaments:ws-connect:${client.handshake.address}`,
          REALTIME_LIMITS.connectsPerIp, REALTIME_LIMITS.windowMs);
        const token = readSessionToken({ headers: { cookie: client.handshake.headers.cookie } });
        const account = await this.sessions.authenticate(token);
        client.data.tournamentIdentity = { userId: account.id, token };
        next();
      } catch {
        next(new Error('TOURNAMENTS_CONNECTION_REJECTED'));
      }
    });
    this.sessions.revocations.on('revoked', this.revoked);
    this.timer = setInterval(() => { void this.sweep(); }, REALTIME_LIMITS.sessionCheckMs);
    this.timer.unref();
    this.listen();
  }

  handleConnection(client: Socket): void {
    const identity = client.data.tournamentIdentity as { userId: string; token: string } | undefined;
    // don't keep the raw session token around
    delete client.data.tournamentIdentity;
    if (!identity || this.live.size >= REALTIME_LIMITS.socketsTotal
      || this.socketsOf(identity.userId) >= REALTIME_LIMITS.socketsPerUser) {
      client.disconnect(true);
      return;
    }
    this.live.set(client.id, {
      client, userId: identity.userId, token: identity.token, hash: hashSessionToken(identity.token), rooms: new Set(),
    });
    void client.join(userRoom(identity.userId));
    client.emit('tournament:ready', {});
  }

  handleDisconnect(client: Socket): void {
    this.live.delete(client.id);
  }

  @SubscribeMessage('tournament:subscribe')
  async subscribe(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): Promise<Ack> {
    const entry = this.live.get(client.id);
    if (!entry) return fail('UNAUTHENTICATED');
    const id = tournamentIdOf(body); // format first: no I/O for malformed input
    if (!id) return fail('INVALID_ID');
    try {
      this.limiter.consume(`tournaments:ws-subscribe:${entry.userId}`,
        REALTIME_LIMITS.subscribesPerUser, REALTIME_LIMITS.windowMs);
    } catch {
      return fail('RATE_LIMITED');
    }
    if (entry.rooms.has(id)) return ok;
    if (entry.rooms.size >= REALTIME_LIMITS.roomsPerSocket) return fail('TOO_MANY_SUBSCRIPTIONS');
    try {
      if (!await this.payloads.tournamentExists(id)) return fail('TOURNAMENT_NOT_FOUND');
    } catch {
      return fail('TOURNAMENTS_UNAVAILABLE');
    }
    if (this.live.get(client.id) !== entry) return fail('UNAUTHENTICATED'); // dropped meanwhile
    await client.join(tournamentRoom(id));
    entry.rooms.add(id);
    return ok;
  }

  @SubscribeMessage('tournament:unsubscribe')
  async unsubscribeRoom(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): Promise<Ack> {
    const entry = this.live.get(client.id);
    if (!entry) return fail('UNAUTHENTICATED');
    const id = tournamentIdOf(body);
    if (!id) return fail('INVALID_ID');
    await client.leave(tournamentRoom(id));
    entry.rooms.delete(id);
    return ok;
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.sessions.revocations.off('revoked', this.revoked);
    for (const off of this.unsubscribe.splice(0)) off();
    for (const entry of [...this.live.values()]) this.drop(entry);
  }

  // Publisher errors are caught there, so a failed emit can't break the HTTP response.

  private listen(): void {
    const e = this.events;
    this.unsubscribe.push(
      e.onParticipantJoined((ev) => this.toTournament(ev.tournamentId, 'tournament:participant_joined', {
        tournamentId: ev.tournamentId, currentParticipants: ev.currentParticipants,
        maxParticipants: ev.maxParticipants, participant: { userId: ev.userId, username: ev.username, displayName: ev.displayName },
      })),
      e.onParticipantLeft((ev) => this.toTournament(ev.tournamentId, 'tournament:participant_left', {
        tournamentId: ev.tournamentId, currentParticipants: ev.currentParticipants,
        maxParticipants: ev.maxParticipants, participant: { userId: ev.userId, username: ev.username, displayName: ev.displayName },
      })),
      e.onRegistrationClosed(async (ev) => {
        this.toTournament(ev.tournamentId, 'tournament:registration_closed', {
          tournamentId: ev.tournamentId, status: ev.outcome,
        });
        if (ev.outcome === 'IN_PROGRESS') {
          this.toTournament(ev.tournamentId, 'tournament:started', await this.payloads.started(ev.tournamentId));
        } else {
          this.toTournament(ev.tournamentId, 'tournament:cancelled', { tournamentId: ev.tournamentId, status: 'CANCELLED' });
        }
      }),
      e.onCancelled((ev) => this.toTournament(ev.tournamentId, 'tournament:cancelled', {
        tournamentId: ev.tournamentId, status: 'CANCELLED',
      })),
      e.onMatchesUpdated(async (ev) => {
        // a cascade can change several matches
        for (const match of await this.payloads.matches(ev.tournamentId, ev.matchIds)) {
          this.toTournament(ev.tournamentId, 'tournament:match_updated', { tournamentId: ev.tournamentId, match });
        }
      }),
      e.onTournamentFinished(async (ev) => {
        this.toTournament(ev.tournamentId, 'tournament:finished', await this.payloads.finished(ev.tournamentId));
      }),
      e.onInvitationReceived(async (ev) => {
        this.toUser(ev.recipientId, 'tournament:invitation_received', await this.payloads.invitationReceived(ev.invitationId));
      }),
      e.onInvitationAnswered(async (ev) => {
        this.toUser(ev.senderId, 'tournament:invitation_answered',
          await this.payloads.invitationAnswered(ev.invitationId, ev.status));
      }),
    );
  }

  private toTournament(tournamentId: string, event: string, payload: unknown): void {
    this.namespace?.to(tournamentRoom(tournamentId)).emit(event, payload);
  }

  private toUser(userId: string, event: string, payload: unknown): void {
    this.namespace?.to(userRoom(userId)).emit(event, payload);
  }

  private socketsOf(userId: string): number {
    let count = 0;
    for (const entry of this.live.values()) if (entry.userId === userId) count++;
    return count;
  }

  private drop(entry: Connection): void {
    if (!this.live.delete(entry.client.id)) return;
    entry.client.disconnect(true);
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const entry of [...this.live.values()]) {
        try {
          const account = await this.sessions.authenticate(entry.token);
          if (account.id !== entry.userId) this.drop(entry);
        } catch (error) {
          // a DB hiccup shouldn't disconnect everyone
          if (error instanceof UnauthorizedException) this.drop(entry);
        }
      }
    } catch (error) {
      this.logger.error(`Session sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.sweeping = false;
    }
  }
}

function tournamentIdOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  const id = (body as { tournamentId?: unknown }).tournamentId;
  if (keys.length !== 1 || keys[0] !== 'tournamentId' || typeof id !== 'string' || !UUID_FORMAT.test(id)) return null;
  return id.toLowerCase();
}
