// Suite-wide guard: no test may touch the developer's real token cache.
//
// `createTokenCache` resolves its path from MCP_DATA_DIR/HOME, so any test with
// MYHOTLUNCHBOX_USERNAME + MYHOTLUNCHBOX_PASSWORD set would read and write
// ~/.myhotlunchbox-mcp/token.json — non-hermetic, order-dependent, and able to
// leave a real file behind.
//
// Three guards, and the third is the one that actually holds:
//   1. The cache is OFF by default, so the ordinary suite never constructs one.
//   2. Its path is pinned into a temp dir, so a test that turns the cache ON to
//      exercise it still cannot reach $HOME.
//   3. A tripwire that FAILS the suite if the real home directory was touched.
//
// The first two work through process.env. That is not sufficient on its own: a
// client reading an INJECTED env bypasses them entirely, and the path resolver
// then falls back to os.homedir(), which no environment variable can redirect.
// Fixing exactly that plumbing in schoolpass-mcp is what created a real file
// under $HOME — so the third guard asserts the outcome rather than the
// mechanism.
//
// The tripwire compares against a snapshot taken before this file's tests run,
// not against bare existence: a developer who runs the MCP locally has a real
// ~/.myhotlunchbox-mcp, and treating that as a leak deleted their live token
// cache and failed the suite on a file no test had touched.
import { beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { assertCacheUntouched, snapshotCache } from './home-guard.js';

const CACHE_DIR = mkdtempSync(join(tmpdir(), 'mhlb-test-cache-'));
const REAL_CACHE = join(homedir(), '.myhotlunchbox-mcp');
const before = snapshotCache(REAL_CACHE);

beforeEach(() => {
  process.env.MYHOTLUNCHBOX_TOKEN_CACHE = 'false';
  process.env.MYHOTLUNCHBOX_TOKEN_FILE = join(CACHE_DIR, 'token.json');
});

afterAll(() => {
  rmSync(CACHE_DIR, { recursive: true, force: true });
  assertCacheUntouched(REAL_CACHE, before);
});
