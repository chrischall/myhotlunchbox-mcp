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
import { EXPECTED_TOOLS } from './index.test.js';
import { testConfig } from './helpers.js';

/**
 * The fleet annotation invariants, read off the LISTED tools (what a client
 * sees) rather than a hand-kept table.
 *
 * `destructiveHint` defaults to TRUE whenever `readOnlyHint` is false, and
 * `openWorldHint` defaults to TRUE when absent, so a forgotten annotation and
 * a considered one can publish identically. Each write must CHOOSE.
 */
interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

async function listedAnnotations(): Promise<Record<string, Ann | undefined>> {
  const client = new MhlbClient(testConfig(), (async () => {
    throw new Error('no network in annotation test');
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
    const out: Record<string, Ann | undefined> = {};
    // harness.listTools() returns names only; the client's own listTools is the
    // wire view, annotations included.
    const { tools } = await harness.client.listTools();
    for (const t of tools) out[t.name] = t.annotations as Ann | undefined;
    return out;
  } finally {
    await harness.close();
  }
}

describe('tool annotations', () => {
  it('covers the full roster (a meta-test that silently drops tools is worse than none)', async () => {
    expect(Object.keys(await listedAnnotations()).sort()).toEqual(EXPECTED_TOOLS);
  });

  it('sets an explicit boolean readOnlyHint on every tool', async () => {
    const missing = Object.entries(await listedAnnotations())
      .filter(([, a]) => typeof a?.readOnlyHint !== 'boolean')
      .map(([n]) => n);
    expect(missing).toEqual([]);
  });

  it('sets an explicit boolean destructiveHint on every write', async () => {
    const undeclared = Object.entries(await listedAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && typeof a?.destructiveHint !== 'boolean')
      .map(([n]) => n);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', async () => {
    const contradictory = Object.entries(await listedAnnotations())
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([n]) => n);
    expect(contradictory).toEqual([]);
  });

  it('sets an explicit boolean openWorldHint on every tool', async () => {
    const missing = Object.entries(await listedAnnotations())
      .filter(([, a]) => typeof a?.openWorldHint !== 'boolean')
      .map(([n]) => n);
    expect(missing).toEqual([]);
  });

  it('marks mhlb_session_reset local-only: it clears the token cache and never touches the network', async () => {
    expect((await listedAnnotations()).mhlb_session_reset).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it('pins the destructive set (growing it should be a decision, not a side effect)', async () => {
    const destructive = Object.entries(await listedAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && a?.destructiveHint === true)
      .map(([n]) => n)
      .sort();
    expect(destructive).toEqual([
      'mhlb_apply_gift_card',
      'mhlb_checkout',
      'mhlb_delete_order',
      'mhlb_delete_student',
      'mhlb_set_subscription_enabled',
      'mhlb_unsubscribe_order',
    ]);
  });
});
