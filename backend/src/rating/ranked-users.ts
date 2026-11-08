import { Prisma } from '@prisma/client';

/**
 * Single source of truth for "who appears in public rankings and statistics".
 * Admin accounts (seeded at 1500 without playing) are excluded so they never
 * occupy rank #1 or skew platform averages.
 */
export const RANKED_USER_WHERE: Prisma.UserWhereInput = { role: { not: 'admin' } };

/** Registration rule (RegisterDto): ASCII letters, digits, underscore, 3-20 chars. */
export const USERNAME_REGEX = /^[A-Za-z0-9_]{3,20}$/;
