import { describe, expect, it } from 'vitest';
import { buildQuery, MhlbClient } from '../src/client.js';
import { withCallSignal, type McpToolError } from '@chrischall/mcp-utils';
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
    expect((err as Error).message).toContain('[REDACTED]');
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

describe('request timeout and cancellation', () => {
  /** A fetch that never answers on its own — it settles only when its signal aborts. */
  const hangingFetch = (hangOn: (url: string) => boolean) =>
    (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const token = tokenHandler()(url);
      if (token && !hangOn(url)) return token;
      if (!hangOn(url)) return jsonResponse({ ok: true });
      const signal = init.signal;
      if (!signal) throw new Error('no signal passed: this call would hang forever');
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as unknown as typeof fetch;

  it('times out a JSON call that the upstream never answers', async () => {
    const client = new MhlbClient(testConfig(), hangingFetch((u) => u.includes('/parent/childrenInfo')), {
      timeoutMs: 20,
    });
    const err = await client.get('/parent/childrenInfo').catch((e: Error) => e);
    expect((err as Error).message).toMatch(/did not answer within/);
  });

  it('says a timed-out write may still have gone through', async () => {
    const client = new MhlbClient(testConfig(), hangingFetch((u) => u.includes('/payment/checkout')), {
      timeoutMs: 20,
    });
    const err = (await client.write('/payment/checkout', { orderIds: [1] }).catch((e) => e)) as McpToolError;
    expect(err.message).toMatch(/did not answer within/);
    expect(err.hint).toMatch(/may still have/i);
  });

  it('times out a report the upstream never finishes generating', async () => {
    const client = new MhlbClient(testConfig(), hangingFetch((u) => u.includes('/parentReports/')), {
      reportTimeoutMs: 20,
    });
    const err = (await client.writeBinary('/parentReports/printCalendar', {}).catch((e) => e)) as McpToolError;
    expect(err.message).toMatch(/did not answer within/);
    // A report changes nothing upstream, so it must not warn about a half-done write.
    expect(err.hint).not.toMatch(/may still have/i);
  });

  it('times out a sign-in the token endpoint never answers', async () => {
    const client = new MhlbClient(testConfig(), hangingFetch((u) => u.endsWith('/api/auth/login')), {
      timeoutMs: 20,
    });
    const err = await client.get('/auth/userinfo').catch((e: Error) => e);
    // "timed out" is what the healthcheck's default classifier keys its
    // `timeout` arm on — not a rejected credential, not an unreachable host.
    expect((err as Error).message).toMatch(/sign-in timed out/);
    expect((err as Error).message).not.toContain('rejected the sign-in');
  });

  it('reports a cancelled sign-in as the cancellation, not as an unreachable host', async () => {
    const client = new MhlbClient(testConfig(), hangingFetch((u) => u.endsWith('/api/auth/login')));
    const controller = new AbortController();
    const pending = withCallSignal(controller.signal, () => client.get('/auth/userinfo'));
    setTimeout(() => controller.abort(new Error('caller cancelled')), 5);
    await expect(pending).rejects.toThrow('caller cancelled');
  });

  it('aborts the in-flight request when the tool call is cancelled', async () => {
    const client = new MhlbClient(testConfig(), hangingFetch((u) => u.includes('/parent/childrenInfo')));
    const controller = new AbortController();
    const pending = withCallSignal(controller.signal, () => client.get('/parent/childrenInfo'));
    setTimeout(() => controller.abort(new Error('caller cancelled')), 5);
    await expect(pending).rejects.toThrow('caller cancelled');
  });
});
