export function requireTestDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error('Set TEST_DATABASE_URL to a dedicated database ending in _test, using the application role.');
  let url: URL;
  try { url = new URL(value); } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !/^\/[a-zA-Z0-9_-]+_test$/.test(decodeURIComponent(url.pathname))) {
    throw new Error('TEST_DATABASE_URL must name a dedicated PostgreSQL database ending in _test.');
  }
  return value;
}
