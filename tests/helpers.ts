import { vi } from 'vitest';
import type { MhlbConfig } from '../src/config.js';

export const TEST_PASSWORD = 'sup3r-secret-parent-pw';

export const testConfig = (over: Partial<MhlbConfig> = {}): MhlbConfig => ({
  baseUrl: 'https://ordernow.example.test',
  username: 'parent@example.com',
  password: TEST_PASSWORD,
  ...over,
});

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const textResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });

/** A token endpoint that always succeeds, plus a scripted queue for API calls. */
export function mockFetch(handlers: Array<(url: string, init: RequestInit) => Response | undefined>) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    for (const handler of handlers) {
      const res = handler(url, init);
      if (res) return res;
    }
    throw new Error(`unexpected fetch: ${init.method ?? 'GET'} ${url}`);
  }) as unknown as typeof fetch;
}

/** Handler that answers the OAuth token endpoint with a fresh access token. */
export const tokenHandler = (
  opts: { accessToken?: string; refreshToken?: string; expiresIn?: number } = {},
) => (url: string) => {
  if (!url.endsWith('/api/auth/login')) return undefined;
  return jsonResponse({
    access_token: opts.accessToken ?? 'access-token-1',
    refresh_token: opts.refreshToken ?? 'refresh-token-1',
    expires_in: opts.expiresIn ?? 3600,
    token_type: 'Bearer',
  });
};
