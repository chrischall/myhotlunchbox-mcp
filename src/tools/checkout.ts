import { randomUUID } from 'node:crypto';
import { McpToolError, toolAnnotations, PositiveInt, schemaConfirm } from '@chrischall/mcp-utils';
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
        ...CheckoutShape,
        confirm: schemaConfirm,
      },
    },
    async ({ confirm, ...args }) => {
      const body = checkoutBody(args);
      if (!confirm) {
        return preview('Initialise checkout', { method: 'POST', path: '/payment/initCheckout', body }, [
          'This step prices the cart and returns payment options. It does not charge a card.',
        ]);
      }
      return jsonResult(await client.write('/payment/initCheckout', body));
    },
  );

  server.registerTool(
    'mhlb_checkout',
    {
      description:
        'PAY for the lunches in the cart. This charges a real payment method on the My Hot Lunchbox account. ' +
        'Run mhlb_init_checkout first, read the total it returns, and pass that same total as expectedTotal — ' +
        'and pass that figure as expectedTotal. Only a card ALREADY SAVED on the account can be used: paying ' +
        'with a new card needs a Stripe token minted in a browser.' + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Pay for cart', readOnly: false, openWorld: true }),
      inputSchema: {
        ...CheckoutShape,
        availableCredits: z
          .number()
          .nonnegative()
          .optional()
          .describe('Account credit to apply, as parent_credit_value from mhlb_whoami.'),
        idempotencyKey: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Reuse the SAME key when retrying a checkout that may already have gone through — that is what ' +
            'stops a retry becoming a second charge. Generated automatically when omitted.',
          ),
        expectedTotal: z
          .number()
          .nonnegative()
          .describe(
            'The amount you expect to be charged, as mhlb_init_checkout reported it. The server prices the ' +
            'charge from orderIds, so no client-side check can bind the amount — this is recorded in the ' +
            'dry run and in the result so an unexpected charge is at least attributable.',
          ),
        confirm: schemaConfirm,
      },
    },
    async ({ availableCredits, idempotencyKey, expectedTotal, confirm, ...args }) => {
      // The site generates this client-side as `${randomUUID()}-${Date.now()}`
      // (form-mixin's getKey) and holds it in session storage across retries.
      const key = idempotencyKey ?? `${randomUUID()}-${Date.now()}`;
      const body = {
        ...checkoutBody(args),
        ...(availableCredits !== undefined ? { availableCredits } : {}),
        idempotencyKey: key,
      };

      if (!confirm) {
        return preview('Pay for cart', { method: 'POST', path: '/payment/checkout', body }, [
          `This CHARGES a payment method. Expected total: ${expectedTotal}.`,
          'No stripeToken is sent, so this can only pay with a card already saved on the account. ' +
            'Paying with a NEW card needs a Stripe token minted by Stripe.js in a browser, which no ' +
            'server-side client can produce — do that on the site.',
          `Idempotency key for this attempt: ${key}. Reuse it if you retry.`,
        ]);
      }

      if (expectedTotal > 0 && args.orderIds.length === 0) {
        throw new McpToolError('Refusing to pay: no orderIds were given.', {
          hint: 'Pass the orderIds mhlb_init_checkout priced, so the charge is bound to specific orders.',
        });
      }

      const result = await client.write<Record<string, unknown> | null>('/payment/checkout', body);
      return jsonResult({ ...(result ?? {}), expectedTotal, idempotencyKey: key });
    },
  );
}

/**
 * The checkout payload the site actually sends, captured from its own
 * `checkout` route chunk:
 *   initCheckout {orderIds, checkoutType, couponCode, giftCardCode, schoolDonations}
 *   checkout     … the same, plus {availableCredits, idempotencyKey, stripeToken}
 *
 * `stripeToken` is deliberately absent here: the site only sets it when paying
 * by a NEW card, and it comes from `Stripe.createToken` in the browser. With a
 * card already saved on the account it is left undefined, which is the only
 * case a server-side client can serve.
 */
const CheckoutShape = {
  orderIds: z
    .array(PositiveInt)
    .describe('Ids of the orders to pay for, from mhlb_get_cart.'),
  checkoutType: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe('Payment method type, as mhlb_init_checkout reports it. Omit to let the server default.'),
  couponCode: z.string().optional().describe('Coupon code to apply to this checkout.'),
  giftCardCode: z.string().optional().describe('Gift card code to apply to this checkout.'),
  schoolDonations: z.unknown().optional().describe('School donation selections, as returned by mhlb_init_checkout.'),
};

function checkoutBody(args: {
  orderIds: number[];
  checkoutType?: number | string;
  couponCode?: string;
  giftCardCode?: string;
  schoolDonations?: unknown;
}): Record<string, unknown> {
  // The site sends these keys explicitly with null rather than omitting them.
  return {
    orderIds: args.orderIds,
    checkoutType: args.checkoutType ?? null,
    couponCode: args.couponCode ?? null,
    giftCardCode: args.giftCardCode ?? null,
    schoolDonations: args.schoolDonations ?? null,
  };
}
