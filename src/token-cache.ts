import {
  createFileStatePersistence,
  resolveStateFile,
  type BearerTokens,
  type SyncStatePersistence,
} from '@chrischall/mcp-utils/session';
import { readEnvVar, parseBoolEnv } from '@chrischall/mcp-utils';

/** Where the OAuth token pair is cached between runs. */
export function tokenCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveStateFile({
    env,
    envVar: 'MYHOTLUNCHBOX_TOKEN_FILE',
    subdir: '.myhotlunchbox-mcp',
    fileName: 'token.json',
  });
}

/** Only a token pair is ever stored — never the username or password. */
function isTokens(raw: unknown): raw is BearerTokens {
  if (raw === null || typeof raw !== 'object') return false;
  const t = raw as Partial<BearerTokens>;
  return (
    typeof t.accessToken === 'string' &&
    t.accessToken !== '' &&
    typeof t.expiresAt === 'number' &&
    (t.refreshToken === undefined || typeof t.refreshToken === 'string')
  );
}

/**
 * The token cache, or `null` when it is off or there are no credentials to
 * bind a record to.
 *
 * A restart currently spends a full password grant for a token that is usually
 * still valid — and, when it is not, a refresh would have done. Caching turns
 * the first case into nothing and the second into one refresh, which matters on
 * a host where a child idles out after ten minutes and every start is cold.
 *
 * The record is bound to the credentials that minted it, so rotating either
 * discards it rather than leaving a token from the old password in play. Only a
 * salted digest is written; neither value reaches the file.
 */
export function createTokenCache(
  env: NodeJS.ProcessEnv = process.env,
): SyncStatePersistence<BearerTokens> | null {
  if (!parseBoolEnv('MYHOTLUNCHBOX_TOKEN_CACHE', { env, default: true })) return null;
  const username = readEnvVar('MYHOTLUNCHBOX_USERNAME', { env });
  const password = readEnvVar('MYHOTLUNCHBOX_PASSWORD', { env });
  if (username === undefined || password === undefined) return null;

  return createFileStatePersistence<BearerTokens>({
    filePath: tokenCachePath(env),
    // Joined on a NUL, written as an escape rather than a literal byte: a
    // password may contain spaces, so a space-joined pair could collide with a
    // different pair by shifting the boundary between the two halves.
    boundTo: [username.trim().toLowerCase(), password].join('\u0000'),
    validate: (raw) => (isTokens(raw) ? raw : null),
  });
}

/**
 * Report a cache write that failed. Not fatal: the tokens are re-mintable from
 * the credentials in the environment, so a lost write costs the next start a
 * login rather than access. Worth saying, though — a read-only data dir
 * otherwise looks exactly like a server that never caches.
 *
 * stderr only; stdout is the JSON-RPC channel.
 */
export function reportCacheWriteFailure(err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(
    `[myhotlunchbox-mcp] could not cache the OAuth tokens (${detail}); continuing ` +
      'without the cache — every restart will log in again until this is fixed.',
  );
}
