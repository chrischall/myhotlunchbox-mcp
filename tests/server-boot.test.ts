import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** Drive a real `initialize` + `tools/list` handshake over stdio. */
async function handshake(entry: string, cwd: string): Promise<string[]> {
  const child = spawn(process.execPath, [entry], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // No credentials: the deferred-config-error pattern must still let it boot.
    env: { ...process.env, MYHOTLUNCHBOX_USERNAME: '', MYHOTLUNCHBOX_PASSWORD: '' },
  });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => (out += d));
  child.stderr.on('data', (d: string) => (err += d));

  const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'boot-test', version: '0' } },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

  const names = await new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out.\nstdout: ${out}\nstderr: ${err}`)), 20_000);
    child.stdout.on('data', () => {
      for (const line of out.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } };
          if (msg.id === 2 && msg.result?.tools) {
            clearTimeout(timer);
            resolve(msg.result.tools.map((t) => t.name));
          }
        } catch {
          /* partial line — wait for more */
        }
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code} before answering.\nstderr: ${err}`));
    });
  }).finally(() => child.kill());

  return names;
}

describe('server boot', () => {
  it('the bin entry point answers the handshake with node_modules present', async () => {
    const names = await handshake(join(root, 'dist/index.js'), root);
    // Not an exact count: PR CI runs the branch merged with main, so a tool
    // added by another PR must not break this. index.test.ts owns the roster.
    expect(names.length).toBeGreaterThanOrEqual(34);
    expect(names).toContain('mhlb_whoami');
  }, 30_000);

  it('the .mcpb bundle boots in a directory with NO node_modules', async () => {
    // This is the .mcpb runtime: an eager import of an esbuild-externalised dep
    // would throw ERR_MODULE_NOT_FOUND here, before `initialize` is answered.
    const dir = mkdtempSync(join(tmpdir(), 'mhlb-mcpb-'));
    scratch.push(dir);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    cpSync(join(root, 'dist/bundle.js'), join(dir, 'dist/bundle.js'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));

    const names = await handshake(join(dir, 'dist/bundle.js'), dir);
    expect(names.length).toBeGreaterThanOrEqual(34);
    expect(names).toContain('mhlb_whoami');
  }, 30_000);
});
