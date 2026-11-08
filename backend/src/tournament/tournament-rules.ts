import { TournamentStatus, VALID_TOURNAMENT_SIZES } from './types/tournament.types';

export const TITLE_LENGTH = Object.freeze({ min: 3, max: 64 });
export const DESCRIPTION_MAX_LENGTH = 255;
export const REGISTRATION_WINDOW = Object.freeze({
  minLeadMs: 5 * 60_000,             // deadline at least 5 minutes ahead
  maxHorizonMs: 30 * 24 * 3_600_000, // and at most 30 days ahead
});
export const TOURNAMENT_SIZES: readonly number[] = VALID_TOURNAMENT_SIZES;

export const TOURNAMENT_TABS = ['open', 'live', 'past'] as const;
export type TournamentTab = (typeof TOURNAMENT_TABS)[number];
export const TAB_STATUSES: Readonly<Record<TournamentTab, readonly TournamentStatus[]>> = Object.freeze({
  open: ['OPEN_FOR_SIGNUP'],
  live: ['REGISTRATION_CLOSED', 'IN_PROGRESS'],
  past: ['FINISHED', 'CANCELLED'],
});
export const PAGE = Object.freeze({ defaultLimit: 20, maxLimit: 50 });

/**
 * Length in code points (what PostgreSQL char_length / VARCHAR(n) count), or -1 when the
 * string contains a lone surrogate (not valid UTF-8; the driver would reject it).
 */
export function codePointLength(value: string): number {
  let length = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return -1;
    length++;
  }
  return length;
}

export type DeadlineProblem = 'TOO_SOON' | 'TOO_FAR';

/** Deadline window check; depends on the clock, so it runs in the service, not the DTO. */
export function checkRegistrationDeadline(deadline: Date, now: Date): DeadlineProblem | null {
  const lead = deadline.getTime() - now.getTime();
  if (lead < REGISTRATION_WINDOW.minLeadMs) return 'TOO_SOON';
  if (lead > REGISTRATION_WINDOW.maxHorizonMs) return 'TOO_FAR';
  return null;
}
