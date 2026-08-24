import { McpToolError, truncateErrorMessage } from '@chrischall/mcp-utils';
import { TokenManager } from '@chrischall/mcp-utils/session';
import { API_PREFIX, OAUTH_SCOPE, type MhlbConfig } from './config.js';

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

  constructor(
    private readonly config: MhlbConfig,
    private readonly fetchImpl: FetchLike = fetch,
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

  private tokenUrl(): string {
    return `${this.config.baseUrl}${API_PREFIX}/auth/login`;
  }

  /**
   * POST a grant to the token endpoint. The web app sends
   * `application/x-www-form-urlencoded` (it builds the body with `qs.stringify`).
   */
  private async postGrant(form: Record<string, string>): Promise<TokenResponse> {
    const { password } = this.config;
    let res: Response;
    try {
      res = await this.fetchImpl(this.tokenUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams(form).toString(),
      });
    } catch (cause) {
      throw new McpToolError(
        `Could not reach My Hot Lunchbox at ${this.config.baseUrl}.`,
        { hint: 'Check network connectivity, or override MYHOTLUNCHBOX_BASE_URL if the app has moved.', cause },
      );
    }

    const raw = await res.text();
    if (!res.ok) {
      let parsed: TokenErrorResponse | null = null;
      try {
        parsed = JSON.parse(raw) as TokenErrorResponse;
      } catch {
        /* non-JSON error body — fall through to the raw text */
      }
      const detail = parsed?.error_description ?? parsed?.error ?? raw;
      // Never auto-retry a rejected credential: these servers count attempts.
      throw new McpToolError(
        `My Hot Lunchbox rejected the sign-in (HTTP ${res.status}): ${scrubCredentials(detail, [password, form.password, form.refresh_token])}`,
        {
          hint:
            parsed?.error === 'invalid_grant'
              ? 'Check MYHOTLUNCHBOX_USERNAME / MYHOTLUNCHBOX_PASSWORD. Do not retry with guesses — repeated failures can lock the account or force a CAPTCHA that blocks server-side sign-in entirely.'
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
    const { username, password } = this.requireCredentials();
    return this.postGrant({
      grant_type: 'password',
      username,
      password,
      scope: OAUTH_SCOPE,
    });
  }

  /**
   * Build (once) the TokenManager that fronts every authenticated call.
   * Single-flight: concurrent first-callers share one login.
   */
  private async ensureManager(): Promise<TokenManager> {
    if (this.manager) return this.manager;
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = (async () => {
      const body = await this.passwordLogin();
      const manager = new TokenManager({
        initial: {
          accessToken: this.assertAccessToken(body),
          refreshToken: body.refresh_token,
          expiresAt: MhlbAuth.expiryOf(body),
        },
        refresh: async (refreshToken: string) => {
          let next: TokenResponse;
          try {
            next = await this.postGrant({ grant_type: 'refresh_token', refresh_token: refreshToken });
          } catch {
            // The refresh token expired or was revoked. We still hold the
            // password, so recover with a full login instead of surfacing a
            // re-auth error the caller cannot act on.
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
    return manager.withAuth(call);
  }

  /** Drop the cached session. Exposed for the `_signout` tool and for tests. */
  reset(): void {
    this.manager = null;
    this.loginInFlight = null;
  }

  /** Raw fetch through the injected implementation (no auth attached). */
  fetch(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(url, init);
  }

  /** Whether a session has been established in this process. */
  get isAuthenticated(): boolean {
    return this.manager !== null;
  }
}
