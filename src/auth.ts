import {
  EdgeBlockedError,
  McpToolError,
  RateLimitError,
  UnreachableError,
  detectEdgeBlock,
  truncateErrorMessage,
  withAmbientCancellation,
} from '@chrischall/mcp-utils';
import { TokenManager } from '@chrischall/mcp-utils/session';
import { API_PREFIX, OAUTH_SCOPE, type MhlbConfig } from './config.js';
import { createTokenCache, reportCacheWriteFailure } from './token-cache.js';

/** Shape of a successful OpenIddict token response. */
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

/** Shape of an OpenIddict error response (`invalid_grant`, etc). */
interface TokenErrorResponse {
  error?: string;
  error_description?: string;
}

/** Fallback lifetime when the server omits `expires_in`. */
const DEFAULT_TOKEN_LIFETIME_S = 3600;

export type FetchLike = typeof fetch;

/** Default per-request timeout for the API and the token endpoint. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The signal every upstream fetch carries: a timeout of its own, combined with
 * the running tool call's cancellation (made ambient by mcp-utils' server
 * wrapper), so a hung upstream cannot hang the tool call and a cancelled call
 * stops waiting.
 */
export function requestSignal(timeoutMs: number): AbortSignal {
  // withAmbientCancellation returns `own` unchanged when there is no ambient
  // signal, so with an own signal in hand it is never undefined.
  return withAmbientCancellation(AbortSignal.timeout(timeoutMs)) as AbortSignal;
}

/** Whether a fetch rejection was our own timeout firing (not the caller cancelling). */
export const isTimeout = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'TimeoutError';

/**
 * The token endpoint answered with an error. Carries the OAuth `error` code so
 * callers can tell a rejected credential (`invalid_grant`) apart from a
 * throttle or an outage — only the former says anything about the password.
 */
class GrantRejectedError extends McpToolError {
  constructor(
    message: string,
    readonly oauthError: string | undefined,
    opts: { hint?: string },
  ) {
    super(message, opts);
  }
}

const isInvalidGrant = (err: unknown): err is GrantRejectedError =>
  err instanceof GrantRejectedError && err.oauthError === 'invalid_grant';

/**
 * Strip the caller's own secrets out of an upstream body before it is ever
 * rendered to a user.
 *
 * `truncateErrorMessage`/`redactSecrets` match secret *shapes* (Bearer, JWT,
 * `sk-`, …). A password has no shape, so it would survive them untouched — and
 * this is the one error path that has just sent one. Splice out the literal
 * values as well. The empty-needle guard matters: `split('')` would splice the
 * placeholder between every character.
 */
export function scrubCredentials(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[redacted]');
  }
  return truncateErrorMessage(out);
}

/**
 * Owns the OAuth2 session against `/api/auth/login`.
 *
 * The web app uses a password grant with `offline_access`, so a real
 * server-side login is possible — no browser bridge, no captured cookie. The
 * refresh token renews the session; if the refresh grant itself fails (the
 * refresh token expired or was revoked) we fall back to a full password login
 * rather than dropping the caller into a re-auth loop.
 */
export class MhlbAuth {
  private manager: TokenManager | null = null;
  private loginInFlight: Promise<TokenManager> | null = null;
  /**
   * Set once the password grant comes back `invalid_grant`. The account locks
   * or forces a CAPTCHA after repeated failures, so every later sign-in fails
   * fast with this error — without touching the network — until
   * {@link reset} (mhlb_session_reset) or a restart.
   */
  private credentialRejected: GrantRejectedError | null = null;
  /**
   * Set once the TokenManager has actually handed out an access token (from
   * the cache, a login or a refresh). The manager itself exists before any
   * sign-in has run, so its presence says nothing about a session.
   */
  private sessionEstablished = false;

  constructor(
    private readonly config: MhlbConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /** Credentials are checked lazily so the server still boots without them. */
  private requireCredentials(): { username: string; password: string } {
    const { username, password } = this.config;
    if (!username || !password) {
      throw new McpToolError('My Hot Lunchbox credentials are not configured.', {
        hint:
          'Set MYHOTLUNCHBOX_USERNAME and MYHOTLUNCHBOX_PASSWORD (the email and password you use at ' +
          'https://ordernow.myhotlunchbox.com) in your .env or MCP host config, then retry.',
      });
    }
    return { username, password };
  }

  /**
   * Refuse to send anything — the password included — to an origin that is
   * not https. Plain http is allowed only to loopback, which is what
   * scripts/capture-writes.mjs points MYHOTLUNCHBOX_BASE_URL at. Checked per
   * call rather than at boot so a bad value still lets the server start and
   * surfaces as a tool error.
   */
  private requireSafeOrigin(): void {
    const { baseUrl } = this.config;
    let url: URL | null = null;
    try {
      url = new URL(baseUrl);
    } catch {
      /* reported below */
    }
    const loopback = url !== null && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url?.protocol === 'https:' || (url?.protocol === 'http:' && loopback)) return;
    throw new McpToolError(`MYHOTLUNCHBOX_BASE_URL (${baseUrl}) is not an https:// origin; refusing to sign in.`, {
      hint:
        'MYHOTLUNCHBOX_BASE_URL must be https:// (plain http is allowed only for localhost). ' +
        'Unset it to use https://ordernow.myhotlunchbox.com.',
    });
  }

  private tokenUrl(): string {
    return `${this.config.baseUrl}${API_PREFIX}/auth/login`;
  }

  /**
   * POST a grant to the token endpoint. The web app sends
   * `application/x-www-form-urlencoded` (it builds the body with `qs.stringify`).
   */
  private async postGrant(form: Record<string, string>): Promise<TokenResponse> {
    const { password } = this.config;
    const signal = requestSignal(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.tokenUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams(form).toString(),
        signal,
      });
    } catch (cause) {
      if (isTimeout(cause)) {
        throw new McpToolError(
          `My Hot Lunchbox sign-in timed out after ${Math.round(this.timeoutMs / 1000)}s.`,
          { hint: 'The sign-in endpoint is slow or down; the credential was never judged. Try again later.', cause },
        );
      }
      // The caller cancelled: let its own reason through rather than calling
      // it a connectivity problem.
      if (signal.aborted) throw cause;
      throw new McpToolError(
        `Could not reach My Hot Lunchbox at ${this.config.baseUrl}.`,
        { hint: 'Check network connectivity, or override MYHOTLUNCHBOX_BASE_URL if the app has moved.', cause },
      );
    }

    const raw = await res.text();
    if (!res.ok) {
      // A CDN/WAF refused the sign-in before the token endpoint saw it, so the
      // password was never judged. Reporting it as "rejected the sign-in"
      // points at a credential on an account that locks on failed attempts.
      // Not an invalid_grant, so it latches nothing and triggers no fallback
      // password grant (chrischall/mcp-host#1015).
      const edge = detectEdgeBlock({ body: raw, headers: res.headers, status: res.status });
      if (edge !== null) {
        throw new EdgeBlockedError(res.status, edge.vendor, {
          service: 'My Hot Lunchbox',
          method: 'POST',
          path: `${API_PREFIX}/auth/login`,
        });
      }
      // A throttle or an outage never judged the password either. Only a 4xx
      // from the token endpoint itself is a verdict on the credential; a 429,
      // a 5xx or a gateway page must not read as "rejected the sign-in",
      // which tells the parent to change a working password and not retry.
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        throw new RateLimitError('My Hot Lunchbox', Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
      }
      if (res.status >= 500) throw new UnreachableError('My Hot Lunchbox', res.status);
      let parsed: TokenErrorResponse | null = null;
      try {
        parsed = JSON.parse(raw) as TokenErrorResponse;
      } catch {
        /* non-JSON error body — fall through to the raw text */
      }
      const detail = parsed?.error_description ?? parsed?.error ?? raw;
      // Never auto-retry a rejected credential: these servers count attempts.
      throw new GrantRejectedError(
        `My Hot Lunchbox rejected the sign-in (HTTP ${res.status}): ${scrubCredentials(detail, [password, form.password, form.refresh_token])}`,
        parsed?.error,
        {
          hint:
            parsed?.error === 'invalid_grant'
              ? 'Check MYHOTLUNCHBOX_USERNAME / MYHOTLUNCHBOX_PASSWORD. Do not retry with guesses — repeated failures can lock the account or force a CAPTCHA that blocks server-side sign-in entirely. ' +
                'Further sign-ins are blocked in this process until the credentials are fixed and mhlb_session_reset is run (or the server restarts).'
              : 'Sign in once at https://ordernow.myhotlunchbox.com to confirm the account is active, then retry.',
        },
      );
    }

    try {
      return JSON.parse(raw) as TokenResponse;
    } catch (cause) {
      throw new McpToolError('My Hot Lunchbox returned a non-JSON token response.', {
        hint: 'The sign-in endpoint may have changed. Re-capture the login request from the web app.',
        cause,
      });
    }
  }

  private static expiryOf(body: TokenResponse): number {
    return Date.now() + (body.expires_in ?? DEFAULT_TOKEN_LIFETIME_S) * 1000;
  }

  private assertAccessToken(body: TokenResponse): string {
    if (!body.access_token) {
      throw new McpToolError('My Hot Lunchbox returned no access token.', {
        hint: 'The sign-in succeeded but carried no `access_token`. Re-capture the login request from the web app.',
      });
    }
    return body.access_token;
  }

  /** Full password grant. */
  private async passwordLogin(): Promise<TokenResponse> {
    if (this.credentialRejected) throw this.credentialRejected;
    const { username, password } = this.requireCredentials();
    try {
      return await this.postGrant({
        grant_type: 'password',
        username,
        password,
        scope: OAUTH_SCOPE,
      });
    } catch (err) {
      if (isInvalidGrant(err)) this.credentialRejected = err;
      throw err;
    }
  }

  /**
   * Build (once) the TokenManager that fronts every authenticated call.
   * Single-flight: concurrent first-callers share one login.
   */
  private async ensureManager(): Promise<TokenManager> {
    this.requireSafeOrigin();
    if (this.manager) return this.manager;
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = (async () => {
      const manager = new TokenManager({
        // The FUNCTION form, so the cache is consulted before the password
        // grant runs at all — the eager object form skips persistence, which
        // would mean a cache that is written and never read.
        initial: async () => {
          const body = await this.passwordLogin();
          return {
            accessToken: this.assertAccessToken(body),
            refreshToken: body.refresh_token,
            expiresAt: MhlbAuth.expiryOf(body),
          };
        },
        persistence: createTokenCache() ?? undefined,
        onPersistError: reportCacheWriteFailure,
        // `refresh` below already recovers from a revoked refresh token by
        // falling back to a full login, so the library's own re-mint-on-revoked
        // recovery would only add a third attempt after both have failed.
        isRefreshRevoked: () => false,
        refresh: async (refreshToken: string) => {
          let next: TokenResponse;
          try {
            next = await this.postGrant({ grant_type: 'refresh_token', refresh_token: refreshToken });
          } catch (err) {
            // Only a refresh token the server REJECTED (expired or revoked)
            // warrants a full login. A 429, a 5xx or a network failure says
            // nothing about the refresh token — answering it with a password
            // grant would spend lockout budget on an outage.
            if (!isInvalidGrant(err)) throw err;
            // We still hold the password, so recover with a full login instead
            // of surfacing a re-auth error the caller cannot act on.
            next = await this.passwordLogin();
          }
          return {
            accessToken: this.assertAccessToken(next),
            refreshToken: next.refresh_token,
            expiresAt: MhlbAuth.expiryOf(next),
          };
        },
      });
      this.manager = manager;
      return manager;
    })();

    try {
      return await this.loginInFlight;
    } finally {
      this.loginInFlight = null;
    }
  }

  /**
   * Run an authenticated request. Delegates to {@link TokenManager.withAuth},
   * which refreshes proactively inside the skew window and replays exactly once
   * on a `401`.
   */
  async withAuth(call: (accessToken: string) => Promise<Response>): Promise<Response> {
    const manager = await this.ensureManager();
    return manager.withAuth((accessToken) => {
      this.sessionEstablished = true;
      return call(accessToken);
    });
  }

  /**
   * Drop the session — in memory AND on disk — and lift a rejected-credential
   * latch, so the next call really signs in again. Backs mhlb_session_reset.
   *
   * The persisted token must go too: a new TokenManager bootstraps from the
   * cache before it would ever log in, so clearing only the in-memory manager
   * hands the same stale token straight back. Cleared through a fresh handle
   * so a reset in a process that has not signed in yet still reaches the file.
   */
  reset(): void {
    this.manager = null;
    this.loginInFlight = null;
    this.credentialRejected = null;
    this.sessionEstablished = false;
    createTokenCache()?.clear();
  }

  /** Raw fetch through the injected implementation (no auth attached). */
  fetch(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(url, init);
  }

  /** Whether a sign-in has actually produced an access token in this process. */
  get isAuthenticated(): boolean {
    return this.sessionEstablished;
  }
}
