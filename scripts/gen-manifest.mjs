// Regenerate manifest.json's `tools` array from the tools the server actually
// registers. Run after adding or renaming a tool:  node scripts/gen-manifest.mjs
import fs from 'node:fs';
import { createTestHarness } from '@chrischall/mcp-utils/test';

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });

const { MhlbClient } = await import('../dist/client.js');
const registrars = await Promise.all(
  ['account', 'students', 'calendar', 'orders', 'billing', 'checkout', 'reports'].map((m) =>
    import(`../dist/tools/${m}.js`),
  ),
);

const client = new MhlbClient({ baseUrl: 'https://example.test', username: undefined, password: undefined });
const harness = await createTestHarness((server) => {
  for (const mod of registrars) {
    for (const fn of Object.values(mod)) if (typeof fn === 'function') fn(server, client);
  }
});

const { tools } = await harness.client.listTools();
await harness.close();

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
manifest.tools = tools
  .map((t) => ({ name: t.name, description: t.description.split('. ')[0].replace(/\.$/, '') + '.' }))
  .sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest.json: ${manifest.tools.length} tools`);
