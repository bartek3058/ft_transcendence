import { Inject, OnModuleDestroy } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { AUTH_CONFIG, AuthConfig } from '../auth/auth.config';
import { AuthRateLimiter } from '../auth/auth-rate-limiter';
import { readSessionToken, hashSessionToken } from '../auth/session-cookie';
import { SessionService } from '../auth/session.service';
import { PrismaService } from '../database/prisma.service';
import { PresenceService } from './presence.service';

type Connection = { client: Socket; userId: string; token: string; hash: string };
@WebSocketGateway({ namespace: '/friends' })
export class FriendsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly live = new Map<string, Connection>();
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  constructor(private readonly sessions: SessionService, private readonly prisma: PrismaService,
    private readonly presence: PresenceService, private readonly limiter: AuthRateLimiter,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}
  private readonly revoked = (hash: string) => {
    for (const entry of [...this.live.values()]) if (entry.hash === hash) this.drop(entry);
  };
  private readonly changed = (ids: string[]) => { void this.notify(ids); };
  private readonly presenceChanged = (id: string) => { void this.notifyFriends(id); };
  afterInit(namespace: Namespace) {
    // Namespace middleware authenticates before Socket.IO exposes a connected client.
    namespace.use(async (client, next) => {
      try {
        if (client.handshake.headers.origin !== this.config.origin || client.handshake.auth?.csrf !== '1') throw new Error();
        this.limiter.consume(`friends:connect:${client.handshake.address}`, 60, 60000);
        const token = readSessionToken({ headers: { cookie: client.handshake.headers.cookie } });
        const account = await this.sessions.authenticate(token);
        client.data.friendIdentity = { userId: account.id, token };
        next();
      } catch { next(new Error('FRIENDS_CONNECTION_REJECTED')); }
    });
    this.sessions.revocations.on('revoked', this.revoked);
    this.presence.events.on('changed', this.changed);
    this.presence.events.on('presence', this.presenceChanged);
    this.timer = setInterval(() => { void this.sweep(); }, 15000);
    this.timer.unref();
  }
  handleConnection(client: Socket) {
    const identity = client.data.friendIdentity;
    if (!identity || this.live.size >= 10000) { client.disconnect(); return; }
    if (!this.presence.connect(identity.userId, client.id)) { client.disconnect(); return; }
    this.live.set(client.id, { client, ...identity, hash: hashSessionToken(identity.token) });
    // Do not retain raw credentials in publicly accessible socket.data.
    delete client.data.friendIdentity;
    client.emit('friends:ready', {});
  }
  handleDisconnect(client: Socket) {
    const entry = this.live.get(client.id);
    if (!entry) return;
    this.live.delete(client.id);
    this.presence.disconnect(entry.userId, client.id);
  }
  private drop(entry: Connection) {
    if (!this.live.delete(entry.client.id)) return;
    this.presence.disconnect(entry.userId, entry.client.id, true);
    entry.client.disconnect(); // Disconnect only this namespace, not matchmaking.
  }
  private async valid(entry: Connection) {
    try {
      const user = await this.sessions.authenticate(entry.token);
      if (user.id !== entry.userId) throw new Error();
      return this.live.get(entry.client.id) === entry;
    } catch { this.drop(entry); return false; }
  }
  private async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const entry of [...this.live.values()]) await this.valid(entry);
    } finally { this.sweeping = false; }
  }
  private async notify(ids: string[]) {
    for (const entry of [...this.live.values()]) {
      if (ids.includes(entry.userId) && await this.valid(entry)) entry.client.emit('friends:changed', {});
    }
  }
  private async notifyFriends(id: string) {
    try {
      const rows = await this.prisma.friendship.findMany({ where: { status: 'ACCEPTED',
        OR: [{ userLowId: id }, { userHighId: id }] }, select: { userLowId: true, userHighId: true } });
      await this.notify(rows.map(row => row.userLowId === id ? row.userHighId : row.userLowId));
    } catch { /* Presence is best-effort; REST refetch on focus/reconnect repairs missed notifications. */ }
  }
  onModuleDestroy() {
    clearInterval(this.timer);
    this.sessions.revocations.off('revoked', this.revoked);
    this.presence.events.off('changed', this.changed);
    this.presence.events.off('presence', this.presenceChanged);
    for (const entry of [...this.live.values()]) this.drop(entry);
  }
}
