import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'node:events';

@Injectable()
export class PresenceService implements OnModuleDestroy {
  readonly events = new EventEmitter();
  private readonly connections = new Map<string, Set<string>>();
  private readonly grace = new Map<string, ReturnType<typeof setTimeout>>();
  isOnline(userId: string) { return this.connections.has(userId) || this.grace.has(userId); }
  connect(userId: string, socketId: string): boolean {
    const set = this.connections.get(userId) ?? new Set<string>();
    if (set.size >= 10 || (!this.isOnline(userId) && this.connections.size + this.grace.size >= 10000)) return false;
    const wasOnline = this.isOnline(userId);
    clearTimeout(this.grace.get(userId));
    this.grace.delete(userId);
    set.add(socketId);
    this.connections.set(userId, set);
    if (!wasOnline) this.events.emit('presence', userId);
    return true;
  }
  disconnect(userId: string, socketId: string, immediate = false) {
    const set = this.connections.get(userId);
    if (!set?.delete(socketId) || set.size) return;
    this.connections.delete(userId);
    if (immediate) {
      this.events.emit('presence', userId);
      return;
    }
    const timer = setTimeout(() => {
      this.grace.delete(userId);
      this.events.emit('presence', userId);
    }, 5000);
    timer.unref();
    this.grace.set(userId, timer);
  }
  changed(...userIds: string[]) { this.events.emit('changed', userIds); }
  onModuleDestroy() {
    for (const timer of this.grace.values()) clearTimeout(timer);
    this.grace.clear(); this.connections.clear(); this.events.removeAllListeners();
  }
}
