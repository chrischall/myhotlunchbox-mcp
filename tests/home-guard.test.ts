import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCacheUntouched, snapshotCache } from './home-guard.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const cacheDirIn = () => {
  const d = mkdtempSync(join(tmpdir(), 'mhlb-guard-'));
  dirs.push(d);
  return join(d, '.myhotlunchbox-mcp');
};

describe('home cache tripwire', () => {
  // The developer's real cache (e.g. from the .mcpb in Claude Desktop) is not
  // a leak. The old tripwire deleted it and failed the suite.
  it('leaves a cache that existed before the suite alone, and passes', () => {
    const dir = cacheDirIn();
    mkdirSync(dir);
    writeFileSync(join(dir, 'token.json'), '{"real":true}');
    const before = snapshotCache(dir);

    expect(() => assertCacheUntouched(dir, before)).not.toThrow();
    expect(readFileSync(join(dir, 'token.json'), 'utf8')).toBe('{"real":true}');
  });

  it('fails, and removes the debris, when the suite created the cache', () => {
    const dir = cacheDirIn();
    const before = snapshotCache(dir);
    mkdirSync(dir);
    writeFileSync(join(dir, 'token.json'), '{}');

    expect(() => assertCacheUntouched(dir, before)).toThrow(/wrote to/);
    expect(existsSync(dir)).toBe(false);
  });

  it('fails, but does not delete, when the suite modified a pre-existing cache', () => {
    const dir = cacheDirIn();
    mkdirSync(dir);
    const file = join(dir, 'token.json');
    writeFileSync(file, '{"real":true}');
    utimesSync(file, new Date(1_000_000), new Date(1_000_000));
    const before = snapshotCache(dir);
    writeFileSync(file, '{"overwritten":true}');

    expect(() => assertCacheUntouched(dir, before)).toThrow(/wrote to/);
    expect(existsSync(file)).toBe(true);
  });

  it('passes when there was no cache before or after', () => {
    const dir = cacheDirIn();
    expect(() => assertCacheUntouched(dir, snapshotCache(dir))).not.toThrow();
  });
});
