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

export interface InvitationReceivedEvent {
  invitationId: string;
  tournamentId: string;
  senderId: string;
  recipientId: string;
  at: Date;
}

export interface InvitationAnsweredEvent extends InvitationReceivedEvent {
  status: 'ACCEPTED' | 'DECLINED';
}

export interface ParticipantChangedEvent {
  tournamentId: string;
  userId: string;
  username: string;
  currentParticipants: number;
  maxParticipants: number;
  at: Date;
}

export interface MatchesUpdatedEvent {
  tournamentId: string;
  // cascades included
  matchIds: string[];
  at: Date;
}

export interface TournamentFinishedEvent {
  tournamentId: string;
  at: Date;
}

type Listener<T> = (event: T) => void | Promise<void>;

const REGISTRATION_CLOSED = 'registration-closed';
const CANCELLED = 'cancelled';
const INVITATION_RECEIVED = 'invitation-received';
const INVITATION_ANSWERED = 'invitation-answered';
const PARTICIPANT_JOINED = 'participant-joined';
const PARTICIPANT_LEFT = 'participant-left';
const MATCHES_UPDATED = 'matches-updated';
const FINISHED = 'finished';

// Publish only after commit. Delivery is deferred and listener errors are only logged.
@Injectable()
export class TournamentEventsPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(TournamentEventsPublisher.name);
  private readonly events = new EventEmitter();

  registrationClosed(event: RegistrationClosedEvent): void {
    setImmediate(() => this.events.emit(REGISTRATION_CLOSED, event));
  }

  cancelled(event: TournamentCancelledEvent): void {
    setImmediate(() => this.events.emit(CANCELLED, event));
  }

  invitationReceived(event: InvitationReceivedEvent): void {
    setImmediate(() => this.events.emit(INVITATION_RECEIVED, event));
  }

  invitationAnswered(event: InvitationAnsweredEvent): void {
    setImmediate(() => this.events.emit(INVITATION_ANSWERED, event));
  }

  participantJoined(event: ParticipantChangedEvent): void {
    setImmediate(() => this.events.emit(PARTICIPANT_JOINED, event));
  }

  participantLeft(event: ParticipantChangedEvent): void {
    setImmediate(() => this.events.emit(PARTICIPANT_LEFT, event));
  }

  matchesUpdated(event: MatchesUpdatedEvent): void {
    setImmediate(() => this.events.emit(MATCHES_UPDATED, event));
  }

  tournamentFinished(event: TournamentFinishedEvent): void {
    setImmediate(() => this.events.emit(FINISHED, event));
  }

  bracketChanged(tournamentId: string, matchIds: string[], finished: boolean): void {
    const at = new Date();
    if (matchIds.length) this.matchesUpdated({ tournamentId, matchIds: [...new Set(matchIds)], at });
    if (finished) this.tournamentFinished({ tournamentId, at });
  }

  onParticipantJoined(listener: Listener<ParticipantChangedEvent>): () => void {
    return this.subscribe(PARTICIPANT_JOINED, listener);
  }

  onParticipantLeft(listener: Listener<ParticipantChangedEvent>): () => void {
    return this.subscribe(PARTICIPANT_LEFT, listener);
  }

  onMatchesUpdated(listener: Listener<MatchesUpdatedEvent>): () => void {
    return this.subscribe(MATCHES_UPDATED, listener);
  }

  onTournamentFinished(listener: Listener<TournamentFinishedEvent>): () => void {
    return this.subscribe(FINISHED, listener);
  }

  onInvitationReceived(listener: Listener<InvitationReceivedEvent>): () => void {
    return this.subscribe(INVITATION_RECEIVED, listener);
  }

  onInvitationAnswered(listener: Listener<InvitationAnsweredEvent>): () => void {
    return this.subscribe(INVITATION_ANSWERED, listener);
  }

  onRegistrationClosed(listener: Listener<RegistrationClosedEvent>): () => void {
    return this.subscribe(REGISTRATION_CLOSED, listener);
  }

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
