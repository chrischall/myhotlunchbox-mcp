import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import type { MhlbClient } from '../client.js';
import { loadConfig, type MhlbConfig } from '../config.js';

/**
 * `mhlb_healthcheck` — the one call that answers "is this connector
 * working?", and the only tool here that reports a failure as DATA rather
 * than throwing.
 *
 * My Hot Lunchbox had none. `mhlb_whoami` looks like one — its own
 * description says "Start here to confirm the session works" — and is not: it
 * is a plain data read that THROWS when auth fails, so the caller gets an
 * exception, not an answer, and cannot tell a bad password from an
 * unreachable host from a lockout.
 *
 * The lockout is why this matters more here than elsewhere. This account
 * counts failed sign-ins and will lock or force a CAPTCHA that blocks
 * server-side sign-in entirely, so a `credential_rejected` hint that invites
 * retrying is actively harmful. {@link classifyMhlbError} carries that
 * warning instead.
 */

const NOT_CONFIGURED = 'credentials are not configured';

export function classifyMhlbError(err: unknown): { kind: string; hint?: string } | undefined {
  const msg = err instanceof Error ? err.message : String(err);

  if (msg.includes(NOT_CONFIGURED)) return { kind: 'no_credential' };
  // The host is unreachable, or MYHOTLUNCHBOX_BASE_URL points somewhere wrong.
  // Nothing here says the credential is bad — do not send anyone to change it.
  if (msg.includes('Could not reach My Hot Lunchbox')) {
    return {
      kind: 'unreachable',
      hint:
        'Could not reach My Hot Lunchbox at all, so the credential was never tested. ' +
        'Check network connectivity, or MYHOTLUNCHBOX_BASE_URL if the app has moved.',
    };
  }
  if (msg.includes('rejected the sign-in')) {
    return {
      kind: 'credential_rejected',
      hint:
        'My Hot Lunchbox rejected the sign-in. Check MYHOTLUNCHBOX_USERNAME / MYHOTLUNCHBOX_PASSWORD against ' +
        'https://ordernow.myhotlunchbox.com — but do NOT re-run this with guesses: repeated failures can lock ' +
        'the account or force a CAPTCHA that blocks server-side sign-in entirely.',
    };
  }
  return undefined;
}

export function registerHealthcheckTools(
  server: McpServer,
  client: MhlbClient,
  /** Seam: injectable so tests need no process env. */
  readConfig: () => MhlbConfig = () => loadConfig(),
): void {
  registerCredentialHealthcheckTool({
    server,
    prefix: 'mhlb',
    hostLabel: 'ordernow.myhotlunchbox.com',
    probePath: '/api/auth/userinfo',
    resolveCredential: async () => {
      const { username, password, baseUrl } = readConfig();
      // Both halves or nothing: a username with no password cannot sign in,
      // and sending it to the API would spend a failed attempt against an
      // account that locks.
      const source = username && password ? 'MYHOTLUNCHBOX_USERNAME+MYHOTLUNCHBOX_PASSWORD' : null;
      return { source, detail: { base_url: baseUrl } };
    },
    // The same authenticated read `mhlb_whoami` makes: cheap, and it changes
    // nothing — no order is placed, no balance moved.
    probeFn: () => client.get('/auth/userinfo'),
    classifyThrown: classifyMhlbError,
  });
}
