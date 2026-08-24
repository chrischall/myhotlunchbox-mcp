import { describe, expect, it } from 'vitest';
import { buildQuery, MhlbClient } from '../src/client.js';
import type { McpToolError } from '@chrischall/mcp-utils';
import { jsonResponse, mockFetch, testConfig, tokenHandler, TEST_PASSWORD } from './helpers.js';

describe('buildQuery', () => {
  it('drops unset values so an absent optional never serializes as "undefined"', () => {
    expect(buildQuery({ a: 1, b: undefined, c: null, d: '', e: false })).toBe('?a=1&e=false');
  });

  it('returns an empty string for no query at all', () => {
    expect(buildQuery(undefined)).toBe('');
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ a: undefined })).toBe('');
  });
});

describe('MhlbClient', () => {
  const apiClient = (handler: (url: string, init: RequestInit) => Response | undefined) =>
    new MhlbClient(testConfig(), mockFetch([tokenHandler(), handler]));

  it('builds URLs under the /api prefix', () => {
    const client = new MhlbClient(testConfig(), mockFetch([tokenHandler()]));
    expect(client.url('/parent/childrenInfo')).toBe(
      'https://ordernow.example.test/api/parent/childrenInfo',
    );
    expect(client.url('parent/childrenInfo', { id: 7 })).toBe(
      'https://ordernow.example.test/api/parent/childrenInfo?id=7',
    );
  });

  it('GETs with a bearer token and no content-type', async () => {
    let seen: RequestInit | undefined;
    const client = apiClient((url, init) => {
      if (!url.includes('/parent/childrenInfo')) return undefined;
      seen = init;
      return jsonResponse([{ id: 1 }]);
    });

    await expect(client.get('/parent/childrenInfo')).resolves.toEqual([{ id: 1 }]);
    const headers = seen?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer access-token-1');
    expect(headers['content-type']).toBeUndefined();
  });

  it('POSTs JSON through write()', async () => {
    let seen: RequestInit | undefined;
    const client = apiClient((url, init) => {
      if (!url.includes('/event/createOrder')) return undefined;
      seen = init;
      return jsonResponse({ ok: true });
    });

    await expect(client.write('/event/createOrder', { eventId: 5 })).resolves.toEqual({ ok: true });
    expect(seen?.method).toBe('POST');
    expect(seen?.body).toBe('{"eventId":5}');
    expect((seen?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('classifies 429 as a rate limit and reads Retry-After', async () => {
    const client = apiClient((url) =>
      url.includes('/parent/childrenInfo')
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })
        : undefined,
    );
    await expect(client.get('/parent/childrenInfo')).rejects.toThrow(/rate/i);
  });

  it('classifies 5xx as unreachable, not as a caller error', async () => {
    const client = apiClient((url) =>
      url.includes('/parent/childrenInfo') ? new Response('boom', { status: 503 }) : undefined,
    );
    await expect(client.get('/parent/childrenInfo')).rejects.toThrow(/unreachable|unavailable|503/i);
  });

  it('explains a 403 as a role mismatch rather than a bad session', async () => {
    const client = apiClient((url) =>
      url.includes('/school/list') ? new Response('denied', { status: 403 }) : undefined,
    );
    const err = await client.get('/school/list').catch((e: Error) => e);
    expect((err as Error).message).toContain('HTTP 403');
    expect((err as McpToolError).hint).toMatch(/not available to a parent account/i);
  });

  it('never renders the password in an upstream error body', async () => {
    const client = apiClient((url) =>
      url.includes('/event/createOrder')
        ? new Response(`rejected password=${TEST_PASSWORD}`, { status: 400 })
        : undefined,
    );

    const err = await client.write('/event/createOrder', {}).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(TEST_PASSWORD);
    expect((err as Error).message).toContain('[redacted]');
  });

  it('reports an HTML sign-in page as a shape problem, not silent garbage', async () => {
    const client = apiClient((url) =>
      url.includes('/parent/childrenInfo')
        ? new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } })
        : undefined,
    );
    await expect(client.get('/parent/childrenInfo')).rejects.toThrow(/non-JSON/);
  });

  it('treats an empty 200 body as null rather than throwing', async () => {
    const client = apiClient((url) =>
      url.includes('/parent/removeCoupon') ? new Response('', { status: 200 }) : undefined,
    );
    await expect(client.write('/parent/removeCoupon')).resolves.toBeNull();
  });

  it('resetSession() clears the cached session', async () => {
    const client = apiClient((url) => (url.includes('/auth/userinfo') ? jsonResponse({ sub: 1 }) : undefined));
    await client.get('/auth/userinfo');
    expect(client.isAuthenticated).toBe(true);
    client.resetSession();
    expect(client.isAuthenticated).toBe(false);
  });
});
