import { describe, expect, it, vi } from 'vitest';
import { MhlbAuth, scrubCredentials } from '../src/auth.js';
import { jsonResponse, mockFetch, testConfig, tokenHandler, TEST_PASSWORD } from './helpers.js';

describe('scrubCredentials', () => {
  it('removes the literal password, which shape-based redaction cannot match', () => {
    const body = `userCredential.password=${TEST_PASSWORD} rejected`;
    const out = scrubCredentials(body, [TEST_PASSWORD]);
    expect(out).not.toContain(TEST_PASSWORD);
    expect(out).toContain('[redacted]');
  });

  it('ignores an empty needle rather than splicing between every character', () => {
    expect(scrubCredentials('hello', [''])).toBe('hello');
    expect(scrubCredentials('hello', [undefined])).toBe('hello');
  });
});

describe('MhlbAuth', () => {
  it('signs in with a password grant and attaches the bearer token', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = mockFetch([
      (url, init) => {
        if (!url.endsWith('/api/auth/login')) return undefined;
        seen.push(init);
        return jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
      },
    ]);

    const auth = new MhlbAuth(testConfig(), fetchImpl);
    const res = await auth.withAuth(async (token) => jsonResponse({ token }));

    expect(await res.json()).toEqual({ token: 'AT' });
    const body = String(seen[0]?.body);
    expect(body).toContain('grant_type=password');
    expect(body).toContain('scope=openid+offline_access+email+profile+roles');
    expect((seen[0]?.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it('shares one login across a concurrent burst', async () => {
    let logins = 0;
    const fetchImpl = mockFetch([
      (url) => {
        if (!url.endsWith('/api/auth/login')) return undefined;
        logins += 1;
        return jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
      },
    ]);

    const auth = new MhlbAuth(testConfig(), fetchImpl);
    await Promise.all([
      auth.withAuth(async () => jsonResponse({})),
      auth.withAuth(async () => jsonResponse({})),
      auth.withAuth(async () => jsonResponse({})),
    ]);

    expect(logins).toBe(1);
  });

  it('falls back to a full password login when the refresh grant fails', async () => {
    const grants: string[] = [];
    const fetchImpl = mockFetch([
      (url, init) => {
        if (!url.endsWith('/api/auth/login')) return undefined;
        const body = new URLSearchParams(String(init.body));
        const grant = body.get('grant_type') ?? '';
        grants.push(grant);
        if (grant === 'refresh_token') return jsonResponse({ error: 'invalid_grant' }, 400);
        return jsonResponse({ access_token: `AT${grants.length}`, refresh_token: 'RT', expires_in: 3600 });
      },
    ]);

    const auth = new MhlbAuth(testConfig(), fetchImpl);
    await auth.withAuth(async () => jsonResponse({}));

    // Force a reactive refresh by answering 401 once.
    let calls = 0;
    const res = await auth.withAuth(async (token) => {
      calls += 1;
      return calls === 1 ? jsonResponse({}, 401) : jsonResponse({ token });
    });

    expect(grants).toEqual(['password', 'refresh_token', 'password']);
    expect(await res.json()).toEqual({ token: 'AT3' });
  });

  it('never renders the password when the sign-in is rejected', async () => {
    const fetchImpl = mockFetch([
      (url) =>
        url.endsWith('/api/auth/login')
          ? jsonResponse(
              {
                error: 'invalid_grant',
                error_description: `Bad credentials for password=${TEST_PASSWORD}`,
              },
              400,
            )
          : undefined,
    ]);

    const auth = new MhlbAuth(testConfig(), fetchImpl);
    const err = await auth.withAuth(async () => jsonResponse({})).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(TEST_PASSWORD);
    expect((err as Error).message).toContain('[redacted]');
  });

  it('does not retry a rejected credential', async () => {
    let attempts = 0;
    const fetchImpl = mockFetch([
      (url) => {
        if (!url.endsWith('/api/auth/login')) return undefined;
        attempts += 1;
        return jsonResponse({ error: 'invalid_grant', error_description: 'nope' }, 400);
      },
    ]);

    const auth = new MhlbAuth(testConfig(), fetchImpl);
    await auth.withAuth(async () => jsonResponse({})).catch(() => undefined);

    expect(attempts).toBe(1);
  });

  it('reports missing credentials without reaching the network', async () => {
    const fetchImpl = vi.fn();
    const auth = new MhlbAuth(testConfig({ username: undefined, password: undefined }), fetchImpl as never);
    const err = await auth.withAuth(async () => jsonResponse({})).catch((e: Error) => e);

    expect((err as Error).message).toContain('credentials are not configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces an unreachable host as a network error, not an auth failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const auth = new MhlbAuth(testConfig(), fetchImpl);
    const err = await auth.withAuth(async () => jsonResponse({})).catch((e: Error) => e);

    expect((err as Error).message).toContain('Could not reach My Hot Lunchbox');
  });

  it('reset() forces the next call to sign in again', async () => {
    let logins = 0;
    const fetchImpl = mockFetch([
      (url) => {
        if (!url.endsWith('/api/auth/login')) return undefined;
        logins += 1;
        return jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
      },
    ]);

    const auth = new MhlbAuth(testConfig(), fetchImpl);
    await auth.withAuth(async () => jsonResponse({}));
    expect(auth.isAuthenticated).toBe(true);

    auth.reset();
    expect(auth.isAuthenticated).toBe(false);
    await auth.withAuth(async () => jsonResponse({}));
    expect(logins).toBe(2);
  });

  it('rejects a token response with no access token', async () => {
    const fetchImpl = mockFetch([
      (url) => (url.endsWith('/api/auth/login') ? jsonResponse({ refresh_token: 'RT' }) : undefined),
    ]);
    const auth = new MhlbAuth(testConfig(), fetchImpl);
    const err = await auth.withAuth(async () => jsonResponse({})).catch((e: Error) => e);
    expect((err as Error).message).toContain('no access token');
  });

  it('rejects a non-JSON token response', async () => {
    const fetchImpl = mockFetch([
      (url) => (url.endsWith('/api/auth/login') ? new Response('<html>down</html>', { status: 200 }) : undefined),
    ]);
    const auth = new MhlbAuth(testConfig(), fetchImpl);
    const err = await auth.withAuth(async () => jsonResponse({})).catch((e: Error) => e);
    expect((err as Error).message).toContain('non-JSON token response');
  });

  it('uses the default lifetime when the server omits expires_in', async () => {
    const fetchImpl = mockFetch([tokenHandler({ expiresIn: undefined as unknown as number })]);
    const auth = new MhlbAuth(testConfig(), fetchImpl);
    await expect(auth.withAuth(async () => jsonResponse({ ok: true }))).resolves.toBeInstanceOf(Response);
  });
});
