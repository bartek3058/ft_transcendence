import { isIP } from 'node:net';

export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

export interface AuthConfig {
  origin: string;
  sessionTtlSeconds: number;
  trustedProxyIp?: string;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const origin = env.APP_ORIGIN ?? 'https://localhost';
  let url: URL;
  try { url = new URL(origin); } catch { throw new Error('APP_ORIGIN must be an HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.origin !== origin) {
    throw new Error('APP_ORIGIN must be an HTTPS origin without path, credentials or trailing slash.');
  }
  const rawTtl = env.SESSION_TTL_SECONDS ?? '604800';
  const sessionTtlSeconds = Number(rawTtl);
  if (!/^\d+$/.test(rawTtl) || !Number.isSafeInteger(sessionTtlSeconds)
    || sessionTtlSeconds < 60 || sessionTtlSeconds > 604800) {
    throw new Error('SESSION_TTL_SECONDS must be between 60 and 604800.');
  }
  const trustedProxyIp = env.TRUSTED_PROXY_IP || undefined;
  if (trustedProxyIp && !isIP(trustedProxyIp)) {
    throw new Error('TRUSTED_PROXY_IP must be one explicit proxy IP address.');
  }
  return Object.freeze({ origin, sessionTtlSeconds, trustedProxyIp });
}
