/**
 * True when an HttpException body already uses the shared `{ error: { code, message } }` envelope.
 * Nest's default bodies are `{ message, error: 'Conflict', statusCode }` (error is a string),
 * so only an object `error` with a string `code` counts.
 */
export function hasErrorEnvelope(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const envelope = (body as { error: unknown }).error;
  return typeof envelope === 'object' && envelope !== null
    && typeof (envelope as { code?: unknown }).code === 'string';
}
