export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_MAX_BYTES = 512;

// Preserve username spelling. Never normalize passwords.
export function normalizeUsername(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

// Email canonicalization for registration, login and rate limiting.
export function normalizeIdentity(value: unknown): unknown {
  return typeof value === 'string'
    ? value.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    : value;
}

export function isValidPassword(value: unknown, minimum: number): value is string {
  if (typeof value !== 'string' || value.length > PASSWORD_MAX_LENGTH * 2) {
    return false;
  }
  let length = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    // for...of combines valid surrogate pairs, but leaves lone surrogates intact.
    if (point >= 0xd800 && point <= 0xdfff) return false;
    length++;
  }
  return length >= minimum && length <= PASSWORD_MAX_LENGTH
    && Buffer.byteLength(value, 'utf8') <= PASSWORD_MAX_BYTES;
}
