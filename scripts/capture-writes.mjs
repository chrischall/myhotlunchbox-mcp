// Capture what every WRITE tool would send, without anything happening upstream.
//
//   npm run build && node scripts/capture-writes.mjs
//
// How it stays safe. A local proxy stands in for the API. Reads are forwarded
// to the real service, so the models the write tools echo back are genuine
// server output rather than fixtures. Writes are intercepted and answered
// locally.
//
// The forwarding rule is DEFAULT-DENY on POST: only paths in READ_POSTS are
// relayed, everything else is captured. A write endpoint someone adds later and
// forgets to list here is therefore blocked, not forwarded — the failure mode
// is a missing capture, never an accidental mutation.
//
// What this proves: the path, query and body each tool constructs, that the
// read-modify-write pairs round-trip a real model, and that confirm gating
// holds. What it does NOT prove: that the server accepts the body. Only a real
// write shows that.
import { createServer } from 'node:http';
import { config } from 'dotenv';
import { writeFileSync } from 'node:fs';

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
config();

/** POSTs that only read. Everything else POSTed is captured, never forwarded. */
const READ_POSTS = new Set([
  '/api/auth/login',
  '/api/calendar/studentSchoolData',
  '/api/parentReports/printCalendar',
  '/api/parentReports/printOrders',
  '/api/parentReports/printTransactions',
]);

const UPSTREAM = process.env.MYHOTLUNCHBOX_REAL_BASE_URL ?? 'https://ordernow.myhotlunchbox.com';
const captured = [];

const redactHeaders = (h) => {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = /^(authorization|cookie)$/i.test(k) ? '[redacted]' : v;
  }
  return out;
};

const proxy = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://127.0.0.1');
    const forwardable = req.method === 'GET' || READ_POSTS.has(url.pathname);

    if (!forwardable) {
      captured.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: redactHeaders(req.headers),
        body: (() => {
          const text = body.toString('utf8');
          if (!text) return null;
          try { return JSON.parse(text); } catch { return text; }
        })(),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ captured: true }));
      return;
    }

    try {
      const upstream = await fetch(`${UPSTREAM}${req.url}`, {
        method: req.method,
        headers: Object.fromEntries(
          Object.entries(req.headers).filter(([k]) => !/^(host|connection|content-length)$/i.test(k)),
        ),
        ...(body.length ? { body } : {}),
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      });
      res.end(buf);
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ proxyError: String(err) }));
    }
  });
});

await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const port = proxy.address().port;
process.env.MYHOTLUNCHBOX_BASE_URL = `http://127.0.0.1:${port}`;
console.log(`proxy on 127.0.0.1:${port} → ${UPSTREAM} (reads forwarded, writes captured)\n`);

const { MhlbClient } = await import('../dist/client.js');
const { createTestHarness, parseToolResult } = await import('@chrischall/mcp-utils/test');
const mods = await Promise.all(
  ['account', 'students', 'calendar', 'orders', 'billing', 'checkout', 'reports'].map((m) =>
    import(`../dist/tools/${m}.js`),
  ),
);

const client = new MhlbClient();
const harness = await createTestHarness((server) => {
  for (const mod of mods) {
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn === 'function' && name.startsWith('register')) fn(server, client);
    }
  }
});

const call = (name, args) => harness.callTool(name, args);
const results = [];
const run = async (label, fn) => {
  const before = captured.length;
  try {
    const r = await fn();
    const got = captured.slice(before);
    results.push({ label, ok: !r?.isError, sent: got.length, error: r?.isError ? text(r) : null });
    console.log(
      r?.isError
        ? `  FAIL ${label}: ${text(r).slice(0, 110)}`
        : `  OK   ${label}: ${got.map((c) => `${c.method} ${c.path}`).join(', ') || 'no request'}`,
    );
  } catch (err) {
    results.push({ label, ok: false, sent: 0, error: String(err) });
    console.log(`  FAIL ${label}: ${String(err).slice(0, 110)}`);
  }
};
const text = (r) => (r?.content ?? []).map((c) => ('text' in c ? c.text : '')).join(' ');

// ---- real models, fetched through the proxy from the real service ----------
const students = parseToolResult(await call('mhlb_list_students'));
const studentId = students[0]?.id;
const cal = parseToolResult(await call('mhlb_get_calendar', { startDate: iso(-30), endDate: iso(30) }));
const events = cal.events ?? [];
const anyEvent = events[0];
const ordered = events.find((e) => e.orderId);
console.log(`models: ${students.length} students, ${events.length} events, order=${ordered?.orderId ?? 'none'}\n`);

function iso(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

console.log('== confirm gating: every write must send NOTHING without confirm ==');
const GATED = [
  ['mhlb_create_student', { student: { firstName: 'X' } }],
  ['mhlb_update_student', { student: { id: studentId } }],
  ['mhlb_delete_student', { studentId }],
  ['mhlb_create_order', { order: { eventId: anyEvent?.id } }],
  ['mhlb_update_order', { order: { id: ordered?.orderId } }],
  ['mhlb_delete_order', { orderId: ordered?.orderId ?? 1, eventDate: iso(0), studentId: studentId ?? 1 }],
  ['mhlb_set_subscription_enabled', { enabled: true }],
  ['mhlb_unsubscribe_order', { orderId: ordered?.orderId ?? 1, eventDate: iso(0), studentId: studentId ?? 1 }],
  ['mhlb_apply_gift_card', { code: 'TEST-CODE' }],
  ['mhlb_apply_coupon', { code: 'TEST-COUPON' }],
  ['mhlb_remove_coupon', {}],
  ['mhlb_init_checkout', { orderIds: [1] }],
  ['mhlb_checkout', { orderIds: [1], expectedTotal: 1 }],
];
let leaked = 0;
for (const [name, args] of GATED) {
  const before = captured.length;
  await call(name, args);
  if (captured.length !== before) {
    leaked += 1;
    console.log(`  LEAK ${name} sent a request WITHOUT confirm`);
  }
}
console.log(leaked === 0 ? `  OK   all ${GATED.length} refused to send without confirm\n` : `  ${leaked} LEAKED\n`);

console.log('== captured write shapes (confirm: true, nothing forwarded) ==');
if (studentId) {
  const form = parseToolResult(await call('mhlb_get_student_form', { studentId }));
  await run('mhlb_update_student (real model echoed back)', () =>
    call('mhlb_update_student', { student: form, confirm: true }));
  const blank = parseToolResult(await call('mhlb_new_student_form'));
  await run('mhlb_create_student (real blank model)', () =>
    call('mhlb_create_student', { student: { ...blank, firstName: 'Proxy Test' }, confirm: true }));
  await run('mhlb_delete_student', () => call('mhlb_delete_student', { studentId, confirm: true }));
}
if (anyEvent) {
  const orderForm = parseToolResult(
    await call('mhlb_get_order_form', { eventId: anyEvent.id, studentId: anyEvent.studentId }),
  );
  await run('mhlb_create_order (real order form)', () =>
    call('mhlb_create_order', { order: orderForm, confirm: true }));
}
if (ordered) {
  const existing = parseToolResult(await call('mhlb_get_order', { orderId: ordered.orderId }));
  await run('mhlb_update_order (real existing order)', () =>
    call('mhlb_update_order', { order: existing, confirm: true }));
  const ref = { orderId: ordered.orderId, eventDate: String(ordered.start).slice(0, 10), studentId: ordered.studentId };
  await run('mhlb_delete_order', () => call('mhlb_delete_order', { ...ref, confirm: true }));
  await run('mhlb_unsubscribe_order', () => call('mhlb_unsubscribe_order', { ...ref, confirm: true }));
}
await run('mhlb_set_subscription_enabled', () =>
  call('mhlb_set_subscription_enabled', { enabled: false, confirm: true }));
await run('mhlb_apply_gift_card', () => call('mhlb_apply_gift_card', { code: 'PROXY-TEST', confirm: true }));
await run('mhlb_apply_coupon', () => call('mhlb_apply_coupon', { code: 'PROXY-TEST', confirm: true }));
await run('mhlb_remove_coupon', () => call('mhlb_remove_coupon', { confirm: true }));
const cartOrderIds = (parseToolResult(await call('mhlb_get_cart')) ?? [])
  .map((row) => row?.orderId)
  .filter((id) => typeof id === 'number');
await run('mhlb_init_checkout', () =>
  call('mhlb_init_checkout', { orderIds: cartOrderIds.length ? cartOrderIds : [1], confirm: true }));
await run('mhlb_checkout', () =>
  call('mhlb_checkout', { orderIds: cartOrderIds.length ? cartOrderIds : [1], expectedTotal: 0, confirm: true }));

await harness.close();
await new Promise((r) => proxy.close(r));

writeFileSync('captured-writes.json', JSON.stringify(captured, null, 2));
console.log(`\n${captured.length} write request(s) captured → captured-writes.json`);
console.log('Nothing was forwarded upstream: every non-read POST was answered locally.');
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('\nfailed:');
  for (const f of failed) console.log(`  ${f.label} — ${String(f.error).slice(0, 160)}`);
}
process.exitCode = failed.length || leaked ? 1 : 0;
