import { Injectable } from '@nestjs/common';
import { QueueEntry } from './pairing';

//In-memory waiting queue. One entry per user (a user cannot sit in the queue twice)
@Injectable()
export class QueueService {
  private readonly entries = new Map<string, QueueEntry>();

  add(entry: QueueEntry): QueueEntry {
    this.entries.set(entry.userId, entry);
    return entry;
  }

  remove(userId: string): boolean {
    return this.entries.delete(userId);
  }

  has(userId: string): boolean {
    return this.entries.has(userId);
  }

  get(userId: string): QueueEntry | undefined {
    return this.entries.get(userId);
  }

  all(): QueueEntry[] {
    return [...this.entries.values()];
  }

  size(): number {
    return this.entries.size;
  }
}
