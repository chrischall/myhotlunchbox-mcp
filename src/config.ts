import { readEnvVar } from '@chrischall/mcp-utils';

/** Default origin of the My Hot Lunchbox ordering app. */
export const DEFAULT_BASE_URL = 'https://ordernow.myhotlunchbox.com';

/** All API routes hang off this prefix (the SPA's axios `baseURL`). */
export const API_PREFIX = '/api';

/**
 * OAuth2 scope the web app requests. `offline_access` is what yields the
 * refresh token, so the server can renew without asking for the password again.
 */
export const OAUTH_SCOPE = 'openid offline_access email profile roles';

export interface MhlbConfig {
  baseUrl: string;
  username: string | undefined;
  password: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MhlbConfig {
  const read = (key: string) => readEnvVar(key, { env });
  return {
    baseUrl: (read('MYHOTLUNCHBOX_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    username: read('MYHOTLUNCHBOX_USERNAME'),
    password: read('MYHOTLUNCHBOX_PASSWORD'),
  };
}
