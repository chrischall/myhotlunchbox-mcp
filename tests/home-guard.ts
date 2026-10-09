// The outcome check behind tests/_setup.ts's tripwire, split out so it can be
// tested itself.
//
// The tripwire has to tell a LEAK from the developer's own cache: anyone
// running the MCP locally (the .mcpb in Claude Desktop, say) has a real
// ~/.myhotlunchbox-mcp/token.json. Seeing that directory after the suite is
// not evidence a test wrote it — only a change since the suite started is.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** What the cache directory looked like: absent, or each entry's size + mtime. */
export type CacheSnapshot = { existed: false } | { existed: true; entries: Record<string, string> };

export function snapshotCache(dir: string): CacheSnapshot {
  if (!existsSync(dir)) return { existed: false };
  const entries: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const st = statSync(join(dir, name));
    entries[name] = `${st.size}:${st.mtimeMs}`;
  }
  return { existed: true, entries };
}

const leakError = (dir: string) =>
  new Error(
    `A test wrote to ${dir}. The suite must never touch the real home ` +
      'directory — inject MYHOTLUNCHBOX_TOKEN_CACHE=false (or a temp ' +
      'MYHOTLUNCHBOX_TOKEN_FILE) into the env that test hands the client.',
  );

/**
 * Throw if the cache directory changed since {@link snapshotCache} ran.
 *
 * A directory the suite CREATED is removed before throwing, so the next run
 * fails on its own leak rather than on this one's debris. A directory that
 * already existed is never deleted — it is the developer's live session — so
 * a write into it fails the suite but leaves the file for them to inspect.
 */
export function assertCacheUntouched(dir: string, before: CacheSnapshot): void {
  const after = snapshotCache(dir);
  if (!before.existed) {
    if (!after.existed) return;
    rmSync(dir, { recursive: true, force: true });
    throw leakError(dir);
  }
  if (!after.existed) throw leakError(dir);
  const a = JSON.stringify(Object.entries(before.entries).sort());
  const b = JSON.stringify(Object.entries(after.entries).sort());
  if (a !== b) throw leakError(dir);
}
