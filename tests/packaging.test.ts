import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { versionSyncTest } from '@chrischall/mcp-utils/test';
import { allTools } from './index.test.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = <T>(file: string): T => JSON.parse(readFileSync(join(root, file), 'utf8')) as T;

const pkg = read<{
  name: string;
  version: string;
  files: string[];
  repository?: { url?: string };
  publishConfig?: { access?: string };
  bin: Record<string, string>;
}>('package.json');

describe('npm publishability', () => {
  // `npm publish --provenance` validates the sigstore bundle against this and
  // rejects the whole publish (E422) if it is missing — after release-please
  // has already tagged, so the release looks green while npm never moves.
  it('declares repository.url matching the GitHub repo', () => {
    expect(pkg.repository?.url).toBe('git+https://github.com/chrischall/myhotlunchbox-mcp.git');
  });

  it('ships skills/ so the bundled skill reaches npm', () => {
    expect(pkg.files).toContain('skills/');
  });

  // mcp-host's registration preview fetches this from
  // cdn.jsdelivr.net/npm/<pkg>@<version>/mcp-host.yaml, which serves the
  // published tarball — so leaving it out of `files` makes the manifest
  // invisible to hosting without any error to notice.
  it('ships mcp-host.yaml so the hosting preview can read it', () => {
    expect(pkg.files).toContain('mcp-host.yaml');
  });

  it('points bin at the tsc entry point, not dist/src', () => {
    expect(pkg.bin['myhotlunchbox-mcp']).toBe('dist/index.js');
  });
});

describe('version sync', () => {
  it('keeps every x-release-please-version marker on package.json#version', () => {
    expect(versionSyncTest({ srcDir: join(root, 'src'), pkgPath: join(root, 'package.json') })).toEqual([]);
  });

  it.each([
    ['manifest.json', (j: { version: string }) => j.version],
    ['server.json', (j: { version: string }) => j.version],
    ['.claude-plugin/plugin.json', (j: { version: string }) => j.version],
  ])('%s carries the package version', (file, pick) => {
    expect(pick(read(file))).toBe(pkg.version);
  });

  it('server.json pins its package version too', () => {
    const server = read<{ packages: { version: string; identifier: string }[] }>('server.json');
    for (const p of server.packages) {
      expect(p.version).toBe(pkg.version);
      expect(p.identifier).toBe(pkg.name);
    }
  });

  it('marketplace.json carries the version in both places', () => {
    const m = read<{ metadata: { version: string }; plugins: { version: string }[] }>('.claude-plugin/marketplace.json');
    expect(m.metadata.version).toBe(pkg.version);
    for (const p of m.plugins) expect(p.version).toBe(pkg.version);
  });
});

describe('registry constraints', () => {
  it('keeps server.json description within the MCP registry limit', () => {
    const { description } = read<{ description: string }>('server.json');
    expect(description.length).toBeLessThanOrEqual(100);
  });
});

describe('manifest tool roster', () => {
  it('matches the registered tools in both directions', async () => {
    const manifest = read<{ tools: { name: string; description: string }[] }>('manifest.json');
    const declared = manifest.tools.map((t) => t.name).sort();
    expect(declared).toEqual(await allTools());
  });

  it('gives every declared tool a non-blank description', () => {
    const manifest = read<{ tools: { name: string; description: string }[] }>('manifest.json');
    for (const tool of manifest.tools) {
      expect(tool.description.trim(), `${tool.name} has a blank description`).not.toBe('');
    }
  });
});
