import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  tokenCachePath,
  createTokenCache,
  reportCacheWriteFailure,
} from '../src/token-cache.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mhlb-cache-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pw = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  MCP_DATA_DIR: dir,
  MYHOTLUNCHBOX_USERNAME: 'eater@example.com',
  MYHOTLUNCHBOX_PASSWORD: 'pw1',
  MYHOTLUNCHBOX_TOKEN_CACHE: 'true',
  ...over,
});

const token = (over: Partial<{ accessToken: string; expiresAt: number }> = {}) => ({
  accessToken: 'TOK',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  ...over,
});

const cacheFile = (d: string): string => join(d, '.myhotlunchbox-mcp', 'token.json');

describe('tokenCachePath', () => {
  it('prefers MCP_DATA_DIR, the variable mcp-host injects', () => {
    expect(tokenCachePath({ MCP_DATA_DIR: '/data' })).toBe('/data/.myhotlunchbox-mcp/token.json');
  });

  it('honours an explicit MYHOTLUNCHBOX_TOKEN_FILE', () => {
    expect(tokenCachePath({ MYHOTLUNCHBOX_TOKEN_FILE: '/tmp/x.json', MCP_DATA_DIR: '/data' })).toBe(
      '/tmp/x.json',
    );
  });

  it('ignores a sentinel override rather than making a relative ./null', () => {
    expect(tokenCachePath({ MYHOTLUNCHBOX_TOKEN_FILE: 'null', HOME: '/home/u' })).toBe(
      '/home/u/.myhotlunchbox-mcp/token.json',
    );
  });
});

describe('credential binding', () => {
  it('round-trips through a 0600 file for the same credentials', () => {
    createTokenCache(pw())!.save(token());
    expect(statSync(cacheFile(dir)).mode & 0o777).toBe(0o600);
    expect(createTokenCache(pw())!.load()).toEqual(expect.objectContaining({ accessToken: 'TOK' }));
  });

  it.each([
    ['a rotated password', pw({ MYHOTLUNCHBOX_PASSWORD: 'pw2' })],
    ['a different account', pw({ MYHOTLUNCHBOX_USERNAME: 'other@example.com' })],
  ])('discards the cache on %s', (_label, env) => {
    createTokenCache(pw())!.save(token());
    expect(createTokenCache(env)!.load()).toBeNull();
  });

  it('is disabled without credentials to bind to', () => {
    expect(createTokenCache({ MCP_DATA_DIR: dir, MYHOTLUNCHBOX_TOKEN_CACHE: 'true' })).toBeNull();
  });

  it('matches the username case-insensitively', () => {
    createTokenCache(pw())!.save(token());
    expect(createTokenCache(pw({ MYHOTLUNCHBOX_USERNAME: '  Eater@Example.COM ' }))!.load()).not.toBeNull();
  });

  it('writes no credential material to disk', () => {
    createTokenCache(pw())!.save(token());
    const body = readFileSync(cacheFile(dir), 'utf8');
    expect(body).not.toContain('pw1');
    expect(body).not.toContain('eater@example.com');
  });
});

describe('stored-record shape guard', () => {
  it.each([
    ['null', null],
    ['a primitive', 'nope'],
    ['a missing accessToken', { expiresAt: 1 }],
    ['an empty accessToken', { accessToken: '', expiresAt: 1 }],
    ['a non-numeric expiresAt', { accessToken: 'T', expiresAt: 'soon' }],
    ['a non-string refreshToken', { accessToken: 'T', refreshToken: 7, expiresAt: 1 }],
  ])('rejects %s rather than handing it to the token manager', (_label, body) => {
    const p = createTokenCache(pw())!;
    p.save(token());
    // Swap only the STATE, keeping the envelope's salted binding intact —
    // overwriting the whole file would be rejected by the binding check before
    // the shape guard ever ran, which is the wrong reason to pass.
    const envelope = JSON.parse(readFileSync(cacheFile(dir), 'utf8')) as { state: unknown };
    envelope.state = body;
    writeFileSync(cacheFile(dir), JSON.stringify(envelope), { mode: 0o600 });
    expect(createTokenCache(pw())!.load()).toBeNull();
  });

  it('accepts a record with no refreshToken', () => {
    const p = createTokenCache(pw())!;
    p.save({ accessToken: 'TOK', expiresAt: 42 });
    expect(p.load()).toEqual({ accessToken: 'TOK', expiresAt: 42 });
  });
});

describe('reportCacheWriteFailure', () => {
  it.each([
    ['an Error', new Error('EROFS'), 'EROFS'],
    ['a non-Error', 'disk gone', 'disk gone'],
  ])('names the cause for %s and stays on stderr', (_label, thrown, expected) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      reportCacheWriteFailure(thrown);
      expect(err).toHaveBeenCalledWith(expect.stringContaining(expected as string));
      // stdout is the JSON-RPC channel; a stray write there corrupts the stream.
      expect(out).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });
});
