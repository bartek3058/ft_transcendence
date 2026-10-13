import { isValidPassword, PASSWORD_MIN_LENGTH } from '../src/auth/validation/input-rules';

export function validateAdminPassword(password: string): string {
  if (!isValidPassword(password, PASSWORD_MIN_LENGTH)) {
    throw new Error('ADMIN_PASSWORD must contain 15–128 valid Unicode characters and at most 512 UTF-8 bytes.');
  }
  return password; // Passwords must never be trimmed or normalized.
}

export function isExistingAdmin(
  users: Array<{ email: string; username: string; role: string }>,
  email: string,
  username: string,
): boolean {
  if (users.length === 0) return false;
  if (users.length === 1 && users[0].email === email
    && users[0].username === username && users[0].role === 'admin') return true;
  throw new Error('Admin bootstrap identity conflicts with an existing account. Choose unused identifiers or configure the existing admin identity.');
}
