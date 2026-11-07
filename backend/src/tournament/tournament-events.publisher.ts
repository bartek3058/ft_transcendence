import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export type CloseReason = 'MANUAL' | 'SCHEDULER';
export type CloseOutcome = 'IN_PROGRESS' | 'CANCELLED';

export interface RegistrationClosedEvent {
  tournamentId: string;
  outcome: CloseOutcome;
  reason: CloseReason;
  at: Date;
}

export interface TournamentCancelledEvent {
  tournamentId: string;
  at: Date;
}

type Listener<T> = (event: T) => void | Promise<void>;

const REGISTRATION_CLOSED = 'registration-closed';
const CANCELLED = 'cancelled';

/**
 * In-process tournament notifications. Publish only after the transaction commits.
 * Delivery is deferred (setImmediate), so the publisher never waits for listeners,
 * and a failing listener is logged without affecting the caller or other listeners.
 */
@Injectable()
export class TournamentEventsPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(TournamentEventsPublisher.name);
  private readonly events = new EventEmitter();

  registrationClosed(event: RegistrationClosedEvent): void {
    setImmediate(() => this.events.emit(REGISTRATION_CLOSED, event));
  }

  /** Manual cancel by the creator or an admin (the scheduler's cancels are registration-closed). */
  cancelled(event: TournamentCancelledEvent): void {
    setImmediate(() => this.events.emit(CANCELLED, event));
  }

  /** Returns an unsubscribe function. */
  onRegistrationClosed(listener: Listener<RegistrationClosedEvent>): () => void {
    return this.subscribe(REGISTRATION_CLOSED, listener);
  }

  /** Returns an unsubscribe function. */
  onCancelled(listener: Listener<TournamentCancelledEvent>): () => void {
    return this.subscribe(CANCELLED, listener);
  }

  private subscribe<T>(name: string, listener: Listener<T>): () => void {
    const safe = (event: T) => {
      try {
        Promise.resolve(listener(event)).catch((error: unknown) => this.report(error));
      } catch (error) {
        this.report(error);
      }
    };
    this.events.on(name, safe);
    return () => { this.events.off(name, safe); };
  }

  onModuleDestroy(): void {
    this.events.removeAllListeners();
  }

  private report(error: unknown): void {
    this.logger.error(`Tournament event listener failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
