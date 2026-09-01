import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { MhlbClient } from '../src/client.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerStudentTools } from '../src/tools/students.js';
import { registerCalendarTools } from '../src/tools/calendar.js';
import { registerOrderTools } from '../src/tools/orders.js';
import { registerBillingTools } from '../src/tools/billing.js';
import { registerCheckoutTools } from '../src/tools/checkout.js';
import { registerReportTools } from '../src/tools/reports.js';
import { registerHealthcheckTools } from '../src/tools/health.js';
import { testConfig } from './helpers.js';

export const EXPECTED_TOOLS = [
  'mhlb_apply_coupon',
  'mhlb_apply_gift_card',
  'mhlb_checkout',
  'mhlb_create_order',
  'mhlb_create_student',
  'mhlb_delete_order',
  'mhlb_delete_student',
  'mhlb_get_calendar',
  'mhlb_get_cart',
  'mhlb_get_cart_tabs',
  'mhlb_get_coupon',
  'mhlb_get_day',
  'mhlb_get_menu',
  'mhlb_get_order',
  'mhlb_get_order_form',
  'mhlb_get_student_form',
  'mhlb_get_subscription_settings',
  'mhlb_get_transaction',
  'mhlb_healthcheck',
  'mhlb_init_checkout',
  'mhlb_list_gift_cards',
  'mhlb_list_students',
  'mhlb_list_subscriptions',
  'mhlb_list_transactions',
  'mhlb_new_student_form',
  'mhlb_print_calendar',
  'mhlb_print_orders',
  'mhlb_print_transaction',
  'mhlb_remove_coupon',
  'mhlb_session_reset',
  'mhlb_set_subscription_enabled',
  'mhlb_unsubscribe_order',
  'mhlb_update_order',
  'mhlb_update_student',
  'mhlb_whoami',
];

export async function allTools(): Promise<string[]> {
  const client = new MhlbClient(testConfig(), (async () => {
    throw new Error('no network in roster test');
  }) as unknown as typeof fetch);
  const harness = await createTestHarness((server) => {
    for (const register of [
      registerAccountTools,
      registerStudentTools,
      registerCalendarTools,
      registerOrderTools,
      registerBillingTools,
      registerCheckoutTools,
      registerReportTools,
      registerHealthcheckTools,
    ]) {
      register(server, client);
    }
  });
  try {
    return (await harness.listTools()).map((t) => t.name).sort();
  } finally {
    await harness.close();
  }
}

describe('tool roster', () => {
  it('registers exactly the expected tools', async () => {
    expect(await allTools()).toEqual(EXPECTED_TOOLS);
  });

  it('names every tool with the mhlb_ prefix', async () => {
    for (const name of await allTools()) expect(name.startsWith('mhlb_')).toBe(true);
  });
});
