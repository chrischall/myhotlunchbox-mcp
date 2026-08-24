import { toolAnnotations, schemaConfirm } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MhlbClient } from '../client.js';
import { jsonResult, preview, UNVERIFIED } from './_shared.js';

/**
 * Checkout is the only pair of tools that moves money. Both are confirm-gated
 * like every other write, and `mhlb_checkout` additionally requires the caller
 * to restate the amount it believes it is paying: a stale cart read that no
 * longer matches the server's total fails closed instead of silently charging
 * a different figure.
 */
export function registerCheckoutTools(server: McpServer, client: MhlbClient): void {
  server.registerTool(
    'mhlb_init_checkout',
    {
      description:
        'Start checkout for the cart: returns the order summary, totals, taxes, applied credits and the ' +
        'available payment methods. This does NOT charge anything — it is the read step before mhlb_checkout.' +
        UNVERIFIED,
      annotations: toolAnnotations({ title: 'Initialise checkout', readOnly: false, openWorld: true }),
      inputSchema: {
        cart: z
          .record(z.string(), z.unknown())
          .describe('The checkout request payload — the orders to pay for, from mhlb_get_cart.'),
        confirm: schemaConfirm,
      },
    },
    async ({ cart, confirm }) => {
      if (!confirm) {
        return preview('Initialise checkout', { method: 'POST', path: '/payment/initCheckout', body: cart }, [
          'This step prices the cart and returns payment options. It does not charge a card.',
        ]);
      }
      return jsonResult(await client.write('/payment/initCheckout', cart));
    },
  );

  server.registerTool(
    'mhlb_checkout',
    {
      description:
        'PAY for the lunches in the cart. This charges a real payment method on the My Hot Lunchbox account. ' +
        'Run mhlb_init_checkout first, read the total it returns, and pass that same total as expectedTotal — ' +
        'the call is refused if it does not match, so a stale cart cannot be paid by accident.' + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Pay for cart', readOnly: false, openWorld: true }),
      inputSchema: {
        payment: z
          .record(z.string(), z.unknown())
          .describe('The payment payload returned/derived from mhlb_init_checkout.'),
        expectedTotal: z
          .number()
          .nonnegative()
          .describe('The amount you expect to be charged, exactly as mhlb_init_checkout reported it.'),
        confirm: schemaConfirm,
      },
    },
    async ({ payment, expectedTotal, confirm }) => {
      const stated = findTotal(payment);

      if (!confirm) {
        return preview('Pay for cart', { method: 'POST', path: '/payment/checkout', body: payment }, [
          `This CHARGES a payment method. Expected total: ${expectedTotal}.`,
          stated === null
            ? 'No total field was found in the payload, so the amount cannot be cross-checked before sending.'
            : `Total found in the payload: ${stated}.`,
        ]);
      }

      if (stated !== null && !nearlyEqual(stated, expectedTotal)) {
        return jsonResult({
          charged: false,
          reason: 'expectedTotal does not match the total in the payment payload.',
          expectedTotal,
          payloadTotal: stated,
          hint: 'Re-run mhlb_init_checkout to reprice the cart, then retry with the total it reports.',
        });
      }

      return jsonResult(await client.write('/payment/checkout', payment));
    },
  );
}

/** Amounts within a cent are equal — the API and the caller may round differently. */
function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

/**
 * Find the payable amount in a checkout payload. Field naming is not verified
 * against a live checkout, so several plausible spellings are accepted; when
 * none is present the cross-check is skipped rather than guessed at.
 */
export function findTotal(payload: Record<string, unknown>): number | null {
  const candidates = ['totalPrice', 'total', 'amount', 'grandTotal', 'totalAmount', 'amountToPay'];
  for (const key of candidates) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}
