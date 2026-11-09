import { registerDecorator } from 'class-validator';

export const DISPLAY_NAME_MIN_LENGTH = 3;
export const DISPLAY_NAME_MAX_LENGTH = 20;

// Letters, marks, digits, punctuation, symbols (emoji included) and the plain space.
// Everything else is out: control and format chars (zero-width, bidi overrides, ZWJ),
// private use, unassigned code points, lone surrogates, tabs and line breaks.
const ALLOWED = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;
// at least one real letter or digit, so a name can't be only marks or symbols
const VISIBLE = /[\p{L}\p{N}]/u;

// NFC, trimmed, inner runs of spaces collapsed. "" means "clear my display name".
export function normalizeDisplayName(value: unknown): unknown {
  return typeof value === 'string' ? value.normalize('NFC').trim().replace(/ {2,}/g, ' ') : value;
}

export function isValidDisplayName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const length = [...value].length; // code points, the same unit as VARCHAR(20)
  return length >= DISPLAY_NAME_MIN_LENGTH && length <= DISPLAY_NAME_MAX_LENGTH
    && ALLOWED.test(value) && VISIBLE.test(value);
}

// Comparison key for uniqueness: NFKC folds look-alike forms (fullwidth, ligatures),
// then lower case. Can be longer than the name, so the column is TEXT.
export function displayNameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().normalize('NFKC');
}

// Valid display name, or "" to clear it.
export function IsDisplayNameOrEmpty(): PropertyDecorator {
  return (target, propertyKey) => registerDecorator({
    name: 'isDisplayNameOrEmpty',
    target: target.constructor,
    propertyName: String(propertyKey),
    validator: { validate: (value: unknown) => value === '' || isValidDisplayName(value) },
  });
}
