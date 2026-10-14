import { createHash, randomBytes } from 'node:crypto';
import { CookieOptions, Request } from 'express';

export const SESSION_COOKIE = '__Host-session';
export const SESSION_COOKIE_OPTIONS: CookieOptions = {
  secure: true, httpOnly: true, sameSite: 'lax', path: '/',
};

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'ascii').digest('hex');
}

// This cookie is deliberately a fixed ASCII token, not arbitrary encoded text.
// Reject duplicate cookies rather than choose an ambiguous first/last token.
export function readSessionToken(request: Pick<Request, 'headers'>): string | null {
  const matches = (request.headers.cookie ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
