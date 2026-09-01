import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import type { MhlbClient } from '../src/client.js';
import { registerHealthcheckTools } from '../src/tools/health.js';
import type { MhlbConfig } from '../src/config.js';

const CONFIG: MhlbConfig = {
  baseUrl: 'https://ordernow.myhotlunchbox.com',
  username: 'parent@example.com',
  password: 'pw',
};

function setup(config: Partial<MhlbConfig> = {}, probe?: () => Promise<unknown>) {
  const get = vi.fn(probe ?? (async () => ({ email: 'parent@example.com' })));
  const client = { get } as unknown as MhlbClient;
  const harness = createTestHarness((s) => registerHealthcheckTools(s, client, () => ({ ...CONFIG, ...config })));
  const call = async () => parseToolResult<any>(await (await harness).callTool('mhlb_healthcheck'));
  const names = async () => (await (await harness).listTools()).map((t) => t.name);
  return { call, get, names };
}

afterEach(() => vi.clearAllMocks());

describe('mhlb_healthcheck', () => {
  it('registers under the repo tool prefix', async () => {
    expect(await setup().names()).toEqual(['mhlb_healthcheck']);
  });

  it('reports ok when the credential resolves and the probe succeeds', async () => {
    const out = await setup().call();
    expect(out.ok).toBe(true);
    expect(out.credential.resolved).toBe(true);
  });

  it('probes the same authenticated read mhlb_whoami makes', async () => {
    const { call, get } = setup();
    await call();
    expect(get).toHaveBeenCalledWith('/auth/userinfo');
  });

  it('names the credential source without echoing the password', async () => {
    const out = await setup({ password: 'SUPER-SECRET' }).call();
    expect(out.credential.source).toBe('MYHOTLUNCHBOX_USERNAME+MYHOTLUNCHBOX_PASSWORD');
    expect(JSON.stringify(out)).not.toContain('SUPER-SECRET');
  });

  it('reports the base URL, which is the other half of the config', async () => {
    const out = await setup().call();
    expect(out.credential.detail.base_url).toBe('https://ordernow.myhotlunchbox.com');
  });

  it('reports missing credentials as no_credential', async () => {
    const out = await setup({ username: undefined, password: undefined }).call();
    expect(out.ok).toBe(false);
    expect(out.error.kind).toBe('no_credential');
  });

  it('treats a half-configured pair as missing, not as a rejected credential', async () => {
    expect((await setup({ password: undefined }).call()).error.kind).toBe('no_credential');
  });

  // This account locks. A hint that invites retrying is actively harmful here.
  it('warns against retrying when the sign-in was rejected', async () => {
    const out = await setup({}, async () => {
      throw new Error('My Hot Lunchbox rejected the sign-in (HTTP 400): invalid_grant');
    }).call();
    expect(out.error.kind).toBe('credential_rejected');
    expect(out.hint).toMatch(/lock|CAPTCHA/i);
    expect(out.hint).not.toMatch(/\bretry\b(?!ing)/i);
  });

  it('separates an unreachable host from a rejected credential', async () => {
    const out = await setup({}, async () => {
      throw new Error('Could not reach My Hot Lunchbox at https://ordernow.myhotlunchbox.com.');
    }).call();
    expect(out.error.kind).toBe('unreachable');
    expect(out.error.kind).not.toBe('credential_rejected');
  });

  it('leaves an unrecognised failure to the helper defaults', async () => {
    const out = await setup({}, async () => { throw new Error('socket hang up'); }).call();
    expect(out.ok).toBe(false);
    expect(out.error.kind).not.toBe('unreachable');
  });

  it('classifies a non-Error throw without crashing', async () => {
    const out = await setup({}, async () => { throw 'Could not reach My Hot Lunchbox at x'; }).call();
    expect(out.error.kind).toBe('unreachable');
  });

  it('reads the real environment when no config loader is injected', async () => {
    vi.stubEnv('MYHOTLUNCHBOX_USERNAME', 'real@example.com');
    vi.stubEnv('MYHOTLUNCHBOX_PASSWORD', 'REAL-PW');
    const h = await createTestHarness((s) =>
      registerHealthcheckTools(s, { get: vi.fn(async () => ({})) } as any),
    );
    const out = parseToolResult<any>(await h.callTool('mhlb_healthcheck'));
    expect(out.credential.resolved).toBe(true);
    expect(JSON.stringify(out)).not.toContain('REAL-PW');
    vi.unstubAllEnvs();
  });
});
