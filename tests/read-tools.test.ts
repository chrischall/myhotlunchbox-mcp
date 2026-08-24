import { describe, expect, it, vi } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { MhlbClient } from '../src/client.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerStudentTools } from '../src/tools/students.js';
import { registerCalendarTools } from '../src/tools/calendar.js';
import { registerOrderTools } from '../src/tools/orders.js';
import { registerBillingTools } from '../src/tools/billing.js';
import { registerCheckoutTools } from '../src/tools/checkout.js';
import { registerReportTools } from '../src/tools/reports.js';
import { jsonResponse, testConfig, tokenHandler } from './helpers.js';

/**
 * Every non-mutating tool, with the arguments it needs and the API path it must
 * reach. Driving all of them proves each path is built correctly — a typo in a
 * route is otherwise invisible until someone calls that one tool in anger.
 */
const READ_TOOLS: Array<[string, Record<string, unknown>, string]> = [
  ['mhlb_whoami', {}, '/api/auth/userinfo'],
  ['mhlb_list_students', {}, '/api/parent/childrenInfo'],
  ['mhlb_get_student_form', { studentId: 1 }, '/api/parent/editChild?childId=1'],
  ['mhlb_new_student_form', {}, '/api/parent/createChild'],
  ['mhlb_get_calendar', { startDate: '2026-09-01', endDate: '2026-09-30' }, '/api/calendar/studentSchoolData'],
  ['mhlb_get_day', { studentId: 1, date: '2026-09-14' }, '/api/calendar/studentOrderItems?studentId=1&date=2026-09-14'],
  ['mhlb_get_cart', {}, '/api/event/shoppingCart'],
  ['mhlb_get_cart_tabs', {}, '/api/event/ShoppingCartBaseData'],
  ['mhlb_get_menu', { studentId: 1, date: '2026-09-14' }, '/api/event/orderBaseData?studentId=1&eventDate=2026-09-14'],
  ['mhlb_get_order_form', { eventId: 2, studentId: 1 }, '/api/event/createOrder?eventId=2&studentId=1'],
  ['mhlb_get_order', { orderId: 3 }, '/api/event/editOrder?orderId=3'],
  ['mhlb_list_transactions', {}, '/api/event/transactionsList'],
  ['mhlb_get_transaction', { transactionId: 9 }, '/api/event/transactionDetails?transactionId=9'],
  ['mhlb_list_subscriptions', {}, '/api/event/upcomingSubscriptions'],
  ['mhlb_get_subscription_settings', {}, '/api/event/subscription'],
  ['mhlb_list_gift_cards', {}, '/api/parent/giftCardDataTables'],
  ['mhlb_get_coupon', {}, '/api/parent/coupon'],
];

async function harness() {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return tokenHandler()(url) ?? jsonResponse({ ok: true });
  });
  const client = new MhlbClient(testConfig(), fetchSpy as unknown as typeof fetch);
  const h = await createTestHarness((server) => {
    registerAccountTools(server, client);
    registerStudentTools(server, client);
    registerCalendarTools(server, client);
    registerOrderTools(server, client);
    registerBillingTools(server, client);
    registerCheckoutTools(server, client);
    registerReportTools(server, client);
  });
  return { h, fetchSpy };
}

describe('read tools reach the right endpoint', () => {
  it.each(READ_TOOLS)('%s → %s', async (name, args, expected) => {
    const { h, fetchSpy } = await harness();
    try {
      const result = await h.callTool(name, args);
      expect(result.isError, `${name} returned an error result`).toBeFalsy();

      const urls = fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => !u.endsWith('/api/auth/login'));
      expect(urls).toHaveLength(1);
      expect(urls[0]).toBe(`https://ordernow.example.test${expected}`);
      expect(urls[0]).not.toContain('undefined');
    } finally {
      await h.close();
    }
  });
});

describe('read tools surface failures as tool errors', () => {
  it('reports an upstream 500 rather than returning an empty result', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return tokenHandler()(url) ?? new Response('boom', { status: 500 });
    });
    const client = new MhlbClient(testConfig(), fetchSpy as unknown as typeof fetch);
    const h = await createTestHarness((server) => registerAccountTools(server, client));
    try {
      const result = await h.callTool('mhlb_whoami');
      expect(result.isError).toBe(true);
    } finally {
      await h.close();
    }
  });
});
