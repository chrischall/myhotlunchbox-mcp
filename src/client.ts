import { McpToolError, RateLimitError, UnreachableError, truncateErrorMessage } from '@chrischall/mcp-utils';
import { MhlbAuth, scrubCredentials, type FetchLike } from './auth.js';
import { API_PREFIX, loadConfig, type MhlbConfig } from './config.js';

/** Query values the API accepts. `undefined` entries are dropped. */
export type QueryValue = string | number | boolean | undefined | null;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
}

/**
 * Build a query string, dropping unset entries so an absent optional never
 * serializes as the literal `"undefined"`.
 */
export function buildQuery(query: Query | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Thin client over the My Hot Lunchbox parent API.
 *
 * Deliberately not `createApiClient`: that helper only ever emits
 * `Authorization: Bearer <token>` from a static `getToken`, whereas every call
 * here has to run inside {@link MhlbAuth.withAuth} so a mid-flight expiry is
 * refreshed and replayed once.
 */
export class MhlbClient {
  readonly config: MhlbConfig;
  private readonly auth: MhlbAuth;

  constructor(config: MhlbConfig = loadConfig(), fetchImpl: FetchLike = fetch) {
    this.config = config;
    this.auth = new MhlbAuth(config, fetchImpl);
  }

  /** Absolute URL for an API path (`/parent/childrenInfo` → `…/api/parent/childrenInfo`). */
  url(path: string, query?: Query): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${this.config.baseUrl}${API_PREFIX}${normalized}${buildQuery(query)}`;
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const target = this.url(path, opts.query);
    const hasBody = opts.body !== undefined;

    const res = await this.auth.withAuth((accessToken) =>
      this.auth.fetch(target, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
      }),
    );

    return this.parse<T>(res, method, path);
  }

  /**
   * Map a non-2xx response onto a typed error. Shared by the JSON and binary
   * paths so a 429 or a role mismatch is classified identically whichever tool
   * hit it.
   *
   * `serverErrorHint` overrides the 5xx branch: the report endpoints answer 500
   * for a request that matches nothing, which is a caller mistake dressed as a
   * server fault, not an outage.
   */
  private classify(res: Response, method: string, path: string, raw: string, serverErrorHint?: string): never {
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new RateLimitError('My Hot Lunchbox', Number.isFinite(retryAfter) ? retryAfter : undefined);
    }
    if (res.status === 403) {
      throw new McpToolError(`My Hot Lunchbox refused ${method} ${path} (HTTP 403).`, {
        hint:
          'This endpoint is not available to a parent account — the same API also serves school-admin and vendor roles. ' +
          'Check that the tool matches your account role.',
      });
    }
    if (res.status >= 500) {
      if (serverErrorHint) {
        throw new McpToolError(
          `My Hot Lunchbox failed to generate the report (HTTP ${res.status}) for ${method} ${path}.`,
          { hint: serverErrorHint },
        );
      }
      throw new UnreachableError('My Hot Lunchbox', res.status);
    }
    throw new McpToolError(
      `My Hot Lunchbox returned HTTP ${res.status} for ${method} ${path}: ${this.scrub(raw)}`,
      { hint: res.status === 400 ? 'The request body or query was rejected. Re-read the resource and resend the model it returned.' : undefined },
    );
  }

  private async parse<T>(res: Response, method: string, path: string): Promise<T> {
    const raw = await res.text();

    if (!res.ok) this.classify(res, method, path, raw);

    if (raw.trim() === '') return null as T;

    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new McpToolError(
        `My Hot Lunchbox returned a non-JSON body for ${method} ${path}: ${truncateErrorMessage(raw, 200)}`,
        { hint: 'The session may have lapsed into an HTML sign-in page, or the endpoint changed shape.' },
      );
    }
  }

  private scrub(text: string): string {
    return scrubCredentials(text, [this.config.password]);
  }

  /** Authenticated GET. */
  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  /**
   * Authenticated POST — the single funnel for every mutation.
   *
   * Every write tool routes through here so auth, error classification and
   * redaction are attached in exactly one place.
   */
  write<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>('POST', path, { body, query });
  }

  /**
   * Authenticated POST whose response is binary, not JSON.
   *
   * The `/parentReports/print*` endpoints are declared `responseType: 'blob'`
   * in the site's own client and return a `%PDF-1.4` stream. Parsing those as
   * JSON throws on the first byte, so they need their own path.
   */
  async writeBinary(
    path: string,
    body: unknown,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const target = this.url(path);
    const res = await this.auth.withAuth((accessToken) =>
      this.auth.fetch(target, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/pdf, application/octet-stream, */*',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    );

    if (!res.ok) {
      this.classify(
        res,
        'POST',
        path,
        await res.text(),
        'This endpoint also answers 500 when the request matches nothing: check that studentIds is ' +
          'non-empty and that the date actually has an order in the status you asked for.',
      );
    }

    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const bytes = new Uint8Array(await res.arrayBuffer());

    // A 200 carrying HTML is the session having lapsed into a sign-in page.
    // Writing that to disk as a .pdf would look like success.
    if (/text\/html|application\/json/i.test(contentType)) {
      throw new McpToolError(
        `My Hot Lunchbox returned ${contentType} for POST ${path}, not a document.`,
        { hint: 'The session may have lapsed. Run mhlb_session_reset and retry.' },
      );
    }

    return { bytes, contentType };
  }

  /** Drop the in-process session (used by the session tool and by tests). */
  resetSession(): void {
    this.auth.reset();
  }

  get isAuthenticated(): boolean {
    return this.auth.isAuthenticated;
  }
}
