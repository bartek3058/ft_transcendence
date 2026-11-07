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

type Listener = (event: RegistrationClosedEvent) => void | Promise<void>;

const REGISTRATION_CLOSED = 'registration-closed';

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

  /** Returns an unsubscribe function. */
  onRegistrationClosed(listener: Listener): () => void {
    const safe = (event: RegistrationClosedEvent) => {
      try {
        Promise.resolve(listener(event)).catch((error: unknown) => this.report(error));
      } catch (error) {
        this.report(error);
      }
    };
    this.events.on(REGISTRATION_CLOSED, safe);
    return () => { this.events.off(REGISTRATION_CLOSED, safe); };
  }

  onModuleDestroy(): void {
    this.events.removeAllListeners();
  }

  private report(error: unknown): void {
    this.logger.error(`Tournament event listener failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
