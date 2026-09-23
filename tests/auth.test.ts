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
    expect((err as Error).message).toContain('[REDACTED]');
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

describe('MhlbAuth — a dead refresh does not trigger a third attempt', () => {
  it('surfaces the failure after refresh and the login fallback both fail', async () => {
    // `refresh` already recovers from a revoked refresh token by falling back to
    // a full password login. Without `isRefreshRevoked: () => false`, the
    // library would then run its OWN re-mint recovery on top — a third call to
    // the same endpoint that just failed twice.
    //
    // The bootstrap has to SUCCEED first: a failed first login never reaches the
    // recovery path, so mocking that would exercise nothing.
    let logins = 0;
    const fetchImpl = mockFetch([
      (url, init) => {
        if (!url.endsWith('/api/auth/login')) return undefined;
        const body = String(init.body);
        if (body.includes('grant_type=password')) {
          logins += 1;
          // First login succeeds with an already-expired token so the very next
          // call must refresh; every later login fails.
          if (logins === 1) {
            return jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: -1 });
          }
          return jsonResponse({ error: 'invalid_grant' }, 400);
        }
        return jsonResponse({ error: 'invalid_grant' }, 400); // the refresh grant
      },
    ]);

    const auth = new MhlbAuth(testConfig(), fetchImpl);
    await expect(auth.withAuth(async (token) => jsonResponse({ token }))).rejects.toThrow();
    // Two password logins: the bootstrap and the one fallback inside `refresh`.
    // A third would be the library recovery this deliberately disables.
    expect(logins).toBe(2);
  });
});

describe('MhlbAuth — reset() with the token cache on', () => {
  it('discards the persisted token so the next call really signs in again', async () => {
    // The cache is the default in production; the suite turns it off. With it
    // on, a new TokenManager bootstraps from token.json first — so a reset that
    // only drops the in-memory manager hands the SAME stale token straight back.
    vi.stubEnv('MYHOTLUNCHBOX_TOKEN_CACHE', 'true');
    vi.stubEnv('MYHOTLUNCHBOX_USERNAME', 'parent@example.com');
    vi.stubEnv('MYHOTLUNCHBOX_PASSWORD', TEST_PASSWORD);
    try {
      let logins = 0;
      const fetchImpl = mockFetch([
        (url) => {
          if (!url.endsWith('/api/auth/login')) return undefined;
          logins += 1;
          return jsonResponse({ access_token: `AT${logins}`, refresh_token: 'RT', expires_in: 3600 });
        },
      ]);

      const first = new MhlbAuth(testConfig(), fetchImpl);
      await first.withAuth(async () => jsonResponse({}));
      expect(logins).toBe(1);

      first.reset();
      const seen: string[] = [];
      await first.withAuth(async (token) => {
        seen.push(token);
        return jsonResponse({});
      });
      expect(logins).toBe(2);
      expect(seen).toEqual(['AT2']);

      // A reset in a fresh process (nothing in memory yet) must also discard
      // the file, or the stale token survives a restart + reset.
      const second = new MhlbAuth(testConfig(), fetchImpl);
      second.reset();
      await second.withAuth(async () => jsonResponse({}));
      expect(logins).toBe(3);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('MhlbAuth — a rejected credential is not replayed', () => {
  it('fails fast without contacting the network after the password grant is rejected', async () => {
    let attempts = 0;
    const fetchImpl = mockFetch([
      (url) => {
        if (!url.endsWith('/api/auth/login')) return undefined;
        attempts += 1;
        return jsonResponse({ error: 'invalid_grant', error_description: 'nope' }, 400);
      },
    ]);

    const auth = new MhlbAuth(testConfig(), fetchImpl);
    const first = await auth.withAuth(async () => jsonResponse({})).catch((e: Error) => e);
    const second = await auth.withAuth(async () => jsonResponse({})).catch((e: Error) => e);
    const third = await auth.withAuth(async () => jsonResponse({})).catch((e: Error) => e);

    expect(attempts).toBe(1);
    expect(first).toBeInstanceOf(Error);
    expect((second as Error).message).toMatch(/rejected/i);
    expect((third as Error).message).toMatch(/rejected/i);
  });

  it('latches a rejection reached through the refresh fallback too', async () => {
    let passwordGrants = 0;
    const fetchImpl = mockFetch([
      (url, init) => {
        if (!url.endsWith('/api/auth/login')) return undefined;
        const body = String(init.body);
        if (body.includes('grant_type=password')) {
          passwordGrants += 1;
          if (passwordGrants === 1) {
            return jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: -1 });
          }
          return jsonResponse({ error: 'invalid_grant' }, 400); // password changed on the site
        }
        return jsonResponse({ error: 'invalid_grant' }, 400);
      },
    ]);

    const auth = new MhlbAuth(testConfig(), fetchImpl);
    await auth.withAuth(async () => jsonResponse({})).catch(() => undefined);
    await auth.withAuth(async () => jsonResponse({})).catch(() => undefined);
    await auth.withAuth(async () => jsonResponse({})).catch(() => undefined);

    // Bootstrap + ONE fallback; later calls fail fast instead of spending
    // another attempt from the lockout budget each.
    expect(passwordGrants).toBe(2);
  });

  it('reset() lifts the latch so fixed credentials can be tried again', async () => {
    let attempts = 0;
    const fetchImpl = mockFetch([
      (url) => {
        if (!url.endsWith('/api/auth/login')) return undefined;
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ error: 'invalid_grant' }, 400)
          : jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
      },
    ]);

    const auth = new MhlbAuth(testConfig(), fetchImpl);
    await auth.withAuth(async () => jsonResponse({})).catch(() => undefined);
    auth.reset();
    await expect(auth.withAuth(async () => jsonResponse({}))).resolves.toBeInstanceOf(Response);
    expect(attempts).toBe(2);
  });

  it.each([
    ['a 429', () => jsonResponse({ error: 'too_many_requests' }, 429)],
    ['a 5xx', () => new Response('upstream down', { status: 503 })],
    [
      'a network failure',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('does not burn a password attempt when the refresh fails with %s', async (_label, refreshFailure) => {
    let passwordGrants = 0;
    const fetchImpl = mockFetch([
      (url, init) => {
        if (!url.endsWith('/api/auth/login')) return undefined;
        const body = String(init.body);
        if (body.includes('grant_type=password')) {
          passwordGrants += 1;
          return jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: -1 });
        }
        return refreshFailure();
      },
    ]);

    const auth = new MhlbAuth(testConfig(), fetchImpl);
    await auth.withAuth(async () => jsonResponse({})).catch(() => undefined);

    expect(passwordGrants).toBe(1);
  });
});
