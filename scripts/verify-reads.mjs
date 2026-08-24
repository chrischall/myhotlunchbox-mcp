// Live read-only verification. Drives every non-mutating tool path through the
// BUILT client, so path building, auth, refresh and error handling are all
// exercised — not just the URL shapes a mocked test would confirm.
//
//   npm run build && node scripts/verify-reads.mjs
//
// Reads only. It never issues a POST that changes state; the three /parentReports
// calls and /calendar/studentSchoolData are POSTs that render or read, not writes.
import { config } from 'dotenv';
import { setTimeout as sleep } from 'node:timers/promises';

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
config();

const { MhlbClient } = await import('../dist/client.js');
const client = new MhlbClient();

if (!client.config.username || !client.config.password) {
  console.error('Set MYHOTLUNCHBOX_USERNAME and MYHOTLUNCHBOX_PASSWORD in .env first.');
  process.exit(1);
}

const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const monthStart = iso(new Date(today.getFullYear(), today.getMonth(), 1));
const monthEnd = iso(new Date(today.getFullYear(), today.getMonth() + 1, 0));

const results = [];
const run = async (label, fn) => {
  try {
    const data = await fn();
    const shape = Array.isArray(data)
      ? `array[${data.length}]`
      : data && typeof data === 'object'
        ? `object{${Object.keys(data).slice(0, 6).join(',')}${Object.keys(data).length > 6 ? ',…' : ''}}`
        : String(data);
    results.push({ label, ok: true, shape });
    console.log(`  OK   ${label} → ${shape}`);
    return data;
  } catch (err) {
    results.push({ label, ok: false, error: err.message.slice(0, 140) });
    console.log(`  FAIL ${label} → ${err.message.slice(0, 140)}`);
    return null;
  } finally {
    await sleep(400); // don't burst a live account
  }
};

console.log('\n== account ==');
await run('mhlb_whoami', () => client.get('/auth/userinfo'));

console.log('\n== students ==');
const students = await run('mhlb_list_students', () => client.get('/parent/childrenInfo'));
const studentId = Array.isArray(students) && students[0]?.id;

console.log('\n== calendar & deliveries ==');
const cal = await run('mhlb_get_calendar', () => client.write('/calendar/studentSchoolData', { start: monthStart, end: monthEnd }));
const events = cal?.events ?? [];
console.log(`  (calendar returned ${events.length} events)`);
const anyEvent = events[0];
const paidEvent = events.find((e) => (e.className ?? []).includes('event-paid'));
if (anyEvent) await run('mhlb_get_day', () => client.get('/calendar/studentOrderItems', { studentId: anyEvent.studentId, date: String(anyEvent.start).slice(0, 10) }));

console.log('\n== cart & menu ==');
await run('mhlb_get_cart_tabs', () => client.get('/event/ShoppingCartBaseData'));
await run('mhlb_get_cart', () => client.get('/event/shoppingCart'));
if (anyEvent) await run('mhlb_get_menu', () => client.get('/event/orderBaseData', { studentId: anyEvent.studentId, eventDate: String(anyEvent.start).slice(0, 10) }));
if (anyEvent) await run('mhlb_get_order_form', () => client.get('/event/createOrder', { eventId: anyEvent.id, studentId: anyEvent.studentId }));
const ordered = events.find((e) => e.orderId);
if (ordered) await run('mhlb_get_order', () => client.get('/event/editOrder', { orderId: ordered.orderId }));

console.log('\n== billing ==');
await run('mhlb_list_transactions', () => client.get('/event/transactionsList'));
await run('mhlb_list_subscriptions', () => client.get('/event/upcomingSubscriptions'));
await run('mhlb_get_subscription_settings', () => client.get('/event/subscription'));
await run('mhlb_list_gift_cards', () => client.get('/parent/giftCardDataTables'));
await run('mhlb_get_coupon', () => client.get('/parent/coupon'));

console.log('\n== reports ==');
const pdf = (r) => `pdf ${r.bytes.byteLength}b ${r.contentType}`;
await run('mhlb_print_calendar', async () =>
  pdf(await client.writeBinary('/parentReports/printCalendar', {
    start: monthStart, end: monthEnd,
    middle: new Date((Date.parse(monthStart) + Date.parse(monthEnd)) / 2).toISOString().slice(0, 10),
    studentIds: (students ?? []).map((s) => s.id),
  })));
if (paidEvent) {
  await run('mhlb_print_orders', async () =>
    pdf(await client.writeBinary('/parentReports/printOrders', {
      orderStatus: 1, eventDate: String(paidEvent.start).slice(0, 10), studentIds: [paidEvent.studentId],
    })));
} else {
  console.log('  SKIP mhlb_print_orders — no paid order in range to render');
}
const txList = await run('mhlb_list_transactions_again', () => client.get('/event/transactionsList'));
const tx = (txList?.transactions ?? [])[0];
if (tx) {
  await run('mhlb_print_transaction', async () =>
    pdf(await client.writeBinary('/parentReports/printTransactions', { ...tx, isCreditType: false })));
} else {
  console.log('  SKIP mhlb_print_transaction — no transaction on the account');
}

const ok = results.filter((r) => r.ok).length;
console.log(`\n${ok}/${results.length} read paths verified live.`);
for (const r of results.filter((x) => !x.ok)) console.log(`  failed: ${r.label} — ${r.error}`);
