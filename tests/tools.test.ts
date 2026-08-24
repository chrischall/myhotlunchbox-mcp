import { describe, expect, it, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { MhlbClient } from '../src/client.js';
import { findTotal } from '../src/tools/checkout.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerStudentTools } from '../src/tools/students.js';
import { registerCalendarTools } from '../src/tools/calendar.js';
import { registerOrderTools } from '../src/tools/orders.js';
import { registerBillingTools } from '../src/tools/billing.js';
import { registerCheckoutTools } from '../src/tools/checkout.js';
import { registerReportTools } from '../src/tools/reports.js';
import { jsonResponse, testConfig, tokenHandler } from './helpers.js';

const ALL_REGISTRARS = [
  registerAccountTools,
  registerStudentTools,
  registerCalendarTools,
  registerOrderTools,
  registerBillingTools,
  registerCheckoutTools,
  registerReportTools,
];

/** Harness whose fetch is a spy, so "did this touch the network?" is assertable. */
async function harnessWithSpy(apiBody: unknown = { ok: true }) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const token = tokenHandler()(url);
    if (token) return token;
    return jsonResponse(apiBody);
  });
  const client = new MhlbClient(testConfig(), fetchSpy as unknown as typeof fetch);
  const harness = await createTestHarness((server) => {
    for (const register of ALL_REGISTRARS) register(server, client);
  });
  return { harness, fetchSpy };
}

/** Every mutating tool, with the minimum arguments needed to reach the gate. */
const WRITE_TOOLS: Array<[string, Record<string, unknown>]> = [
  ['mhlb_create_student', { student: { firstName: 'Test' } }],
  ['mhlb_update_student', { student: { id: 1 } }],
  ['mhlb_delete_student', { studentId: 1 }],
  ['mhlb_create_order', { order: { eventId: 1 } }],
  ['mhlb_update_order', { order: { orderId: 1 } }],
  ['mhlb_delete_order', { order: { orderId: 1 } }],
  ['mhlb_set_subscription_enabled', { enabled: true }],
  ['mhlb_unsubscribe_order', { order: { orderId: 1 } }],
  ['mhlb_apply_gift_card', { code: 'GC-1' }],
  ['mhlb_apply_coupon', { code: 'SAVE10' }],
  ['mhlb_remove_coupon', {}],
  ['mhlb_init_checkout', { cart: { orderIds: [1] } }],
  ['mhlb_checkout', { payment: { totalPrice: 10 }, expectedTotal: 10 }],
];

describe('confirm gating', () => {
  it.each(WRITE_TOOLS)('%s makes no network call without confirm', async (name, args) => {
    const { harness, fetchSpy } = await harnessWithSpy();
    try {
      const result = await harness.callTool(name, args);
      const body = parseToolResult<{ dryRun: boolean; wouldSend: { method: string; path: string } }>(result);

      expect(body.dryRun).toBe(true);
      expect(body.wouldSend.method).toBe('POST');
      expect(body.wouldSend.path).toMatch(/^\//);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it.each(WRITE_TOOLS)('%s does call through with confirm: true', async (name, args) => {
    const { harness, fetchSpy } = await harnessWithSpy();
    try {
      await harness.callTool(name, { ...args, confirm: true });
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });
});

describe('read tools', () => {
  it('mhlb_whoami returns the account claims', async () => {
    const { harness } = await harnessWithSpy({ sub: 42, name: 'Test Parent', students_count: 2 });
    try {
      const body = parseToolResult<{ sub: number; students_count: number }>(
        await harness.callTool('mhlb_whoami'),
      );
      expect(body).toMatchObject({ sub: 42, students_count: 2 });
    } finally {
      await harness.close();
    }
  });

  it('mhlb_list_students hits /parent/childrenInfo', async () => {
    const { harness, fetchSpy } = await harnessWithSpy([{ id: 1, firstName: 'Finn' }]);
    try {
      await harness.callTool('mhlb_list_students');
      const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.endsWith('/api/parent/childrenInfo'))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('mhlb_get_calendar posts the date range', async () => {
    const { harness, fetchSpy } = await harnessWithSpy({ days: [] });
    try {
      await harness.callTool('mhlb_get_calendar', { startDate: '2026-09-01', endDate: '2026-09-30' });
      const call = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/calendar/studentSchoolData'));
      // `start`/`end`, not `startDate`/`endDate`: the wrong names return 200
      // with an empty events array rather than an error.
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
        start: '2026-09-01',
        end: '2026-09-30',
      });
    } finally {
      await harness.close();
    }
  });

  it('mhlb_get_cart drops unset filters from the query string', async () => {
    const { harness, fetchSpy } = await harnessWithSpy([]);
    try {
      await harness.callTool('mhlb_get_cart', { studentId: 7 });
      const url = fetchSpy.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/event/shoppingCart'));
      expect(url).toContain('selectedStudentId=7');
      expect(url).not.toContain('orderStatus');
      expect(url).not.toContain('undefined');
    } finally {
      await harness.close();
    }
  });

  it('mhlb_session_reset clears the session without touching the network', async () => {
    const { harness, fetchSpy } = await harnessWithSpy();
    try {
      const body = parseToolResult<{ reset: boolean }>(await harness.callTool('mhlb_session_reset'));
      expect(body.reset).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });
});

describe('checkout safety', () => {
  it('refuses to pay when expectedTotal disagrees with the payload total', async () => {
    const { harness, fetchSpy } = await harnessWithSpy();
    try {
      const body = parseToolResult<{ charged: boolean; payloadTotal: number }>(
        await harness.callTool('mhlb_checkout', {
          payment: { totalPrice: 42.5 },
          expectedTotal: 10,
          confirm: true,
        }),
      );
      expect(body.charged).toBe(false);
      expect(body.payloadTotal).toBe(42.5);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it('pays when the totals agree', async () => {
    const { harness, fetchSpy } = await harnessWithSpy({ receiptId: 9 });
    try {
      await harness.callTool('mhlb_checkout', {
        payment: { totalPrice: 42.5 },
        expectedTotal: 42.5,
        confirm: true,
      });
      expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/payment/checkout'))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('warns in the dry run when no total can be cross-checked', async () => {
    const { harness } = await harnessWithSpy();
    try {
      const body = parseToolResult<{ notes: string[] }>(
        await harness.callTool('mhlb_checkout', { payment: { foo: 'bar' }, expectedTotal: 5 }),
      );
      expect(body.notes.join(' ')).toMatch(/cannot be cross-checked/i);
    } finally {
      await harness.close();
    }
  });

  it('findTotal reads the common spellings and gives up cleanly otherwise', () => {
    expect(findTotal({ totalPrice: 12 })).toBe(12);
    expect(findTotal({ amount: '8.25' })).toBe(8.25);
    expect(findTotal({ grandTotal: 0 })).toBe(0);
    expect(findTotal({ nothing: 'here' })).toBeNull();
    expect(findTotal({ amount: '' })).toBeNull();
    expect(findTotal({ total: Number.NaN })).toBeNull();
  });
});
