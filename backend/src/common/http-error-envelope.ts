// Nest's default body has `error` as a string, ours is an object with a `code`.
export function hasErrorEnvelope(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const envelope = (body as { error: unknown }).error;
  return typeof envelope === 'object' && envelope !== null
    && typeof (envelope as { code?: unknown }).code === 'string';
}
