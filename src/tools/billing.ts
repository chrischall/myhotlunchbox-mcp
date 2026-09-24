import { toolAnnotations, PositiveInt, NonEmptyString, confirmTokenParam } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MhlbClient } from '../client.js';
import { CONFIRMS, UNVERIFIED, confirmWrite, minifiedResult } from './_shared.js';
import { OrderRefShape, orderRefBody } from './orders.js';

export function registerBillingTools(server: McpServer, client: MhlbClient): void {
  server.registerTool(
    'mhlb_list_transactions',
    {
      description: 'List payment transactions on the account — date, amount, and what was paid for.',
      annotations: toolAnnotations({ title: 'List transactions', openWorld: true }),
      inputSchema: z.object({
        period: z.string().optional().describe('Ordering period to scope to, from mhlb_get_cart_tabs.'),
        studentId: PositiveInt.optional().describe('Limit to one student.'),
      }),
    },
    async ({ period, studentId }) =>
      minifiedResult(await client.get('/event/transactionsList', { selectedPeriod: period, selectedStudentId: studentId })),
  );

  server.registerTool(
    'mhlb_get_transaction',
    {
      description: 'Get the line-item detail of one transaction — which lunches it paid for.',
      annotations: toolAnnotations({ title: 'Get transaction', openWorld: true }),
      inputSchema: z.object({ transactionId: PositiveInt.describe('Transaction id (the `id` field from mhlb_list_transactions).') }),
    },
    // The query parameter is `id`, not `transactionId` — verified live.
    async ({ transactionId }) => minifiedResult(await client.get('/event/transactionDetails', { id: transactionId })),
  );

  server.registerTool(
    'mhlb_list_subscriptions',
    {
      description:
        'List upcoming lunch subscriptions — the recurring orders that will be placed and charged automatically.',
      annotations: toolAnnotations({ title: 'List subscriptions', openWorld: true }),
      inputSchema: z.object({ period: z.string().optional().describe('Ordering period to scope to.') }),
    },
    async ({ period }) => minifiedResult(await client.get('/event/upcomingSubscriptions', { period })),
  );

  server.registerTool(
    'mhlb_get_subscription_settings',
    {
      description: 'Get the account’s subscription configuration — whether recurring ordering is on, and its terms.',
      annotations: toolAnnotations({ title: 'Get subscription settings', openWorld: true }),
      inputSchema: z.object({}),
    },
    async () => minifiedResult(await client.get('/event/subscription')),
  );

  server.registerTool(
    'mhlb_set_subscription_enabled',
    {
      description:
        'Turn recurring lunch subscriptions on or off for the account. Turning it ON means future lunches are ' +
        'ordered and charged automatically.' + CONFIRMS + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Enable/disable subscriptions', readOnly: false, openWorld: true, destructive: true }),
      inputSchema: z.object({
        enabled: z.boolean().describe('true to enable recurring subscriptions, false to disable.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ enabled, confirmToken }, ctx) => {
      const gate = await confirmWrite(ctx, {
        tool: 'mhlb_set_subscription_enabled',
        action: 'subscription.set_enabled',
        label: `${enabled ? 'Enable' : 'Disable'} subscriptions`,
        target: '',
        request: { method: 'POST', path: '/parent/changeSubscriptionStatus', query: { isEnableSubscription: enabled } },
        confirmToken,
        notes: enabled ? ['Enabling means future lunches are ordered and charged automatically.'] : [],
      });
      if (gate) return gate;
      return minifiedResult(
        await client.write('/parent/changeSubscriptionStatus', undefined, { isEnableSubscription: enabled }),
      );
    },
  );

  server.registerTool(
    'mhlb_unsubscribe_order',
    {
      description: 'Stop a recurring subscription for a specific lunch order.' + CONFIRMS + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Unsubscribe an order', readOnly: false, openWorld: true, destructive: true }),
      // Same identifier payload as mhlb_delete_order — the site's order-mixin
      // routes to whichever endpoint by `isSubscribed`, with one body shape.
      inputSchema: z.object({ ...OrderRefShape, confirmToken: confirmTokenParam }),
    },
    // The upstream route really is spelled `unsubcribeOrder`.
    async ({ confirmToken, ...ref }, ctx) => {
      const body = orderRefBody({ ...ref, isSubscribed: ref.isSubscribed ?? true });
      const gate = await confirmWrite(ctx, {
        tool: 'mhlb_unsubscribe_order',
        action: 'order.unsubscribe',
        label: 'Unsubscribe order',
        target: String(ref.orderId),
        request: { method: 'POST', path: '/event/unsubcribeOrder', body },
        confirmToken,
        notes: ['isRepeated: true stops the whole recurring series, not just this date.'],
      });
      if (gate) return gate;
      return minifiedResult(await client.write('/event/unsubcribeOrder', body));
    },
  );

  server.registerTool(
    'mhlb_list_gift_cards',
    {
      description: 'List gift cards on the account — codes, balances and status.',
      annotations: toolAnnotations({ title: 'List gift cards', openWorld: true }),
      inputSchema: z.object({}),
    },
    async () => minifiedResult(await client.get('/parent/giftCardDataTables')),
  );

  server.registerTool(
    'mhlb_apply_gift_card',
    {
      description: 'Redeem a gift card code onto the account balance.' + CONFIRMS + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Apply gift card', readOnly: false, openWorld: true, destructive: true }),
      inputSchema: z.object({ code: NonEmptyString.describe('Gift card code.'), confirmToken: confirmTokenParam }),
    },
    async ({ code, confirmToken }, ctx) => {
      const gate = await confirmWrite(ctx, {
        tool: 'mhlb_apply_gift_card',
        action: 'gift_card.apply',
        label: 'Apply gift card',
        target: code,
        request: { method: 'POST', path: '/parent/applyGiftCard', query: { giftCardCode: code } },
        confirmToken,
      });
      if (gate) return gate;
      return minifiedResult(await client.write('/parent/applyGiftCard', undefined, { giftCardCode: code }));
    },
  );

  server.registerTool(
    'mhlb_get_coupon',
    {
      description: 'Get the coupon currently applied to the account, if any.',
      annotations: toolAnnotations({ title: 'Get applied coupon', openWorld: true }),
      inputSchema: z.object({}),
    },
    async () => minifiedResult(await client.get('/parent/coupon')),
  );

  server.registerTool(
    'mhlb_apply_coupon',
    {
      description: 'Apply a coupon code to the account.' + CONFIRMS + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Apply coupon', readOnly: false, openWorld: true, destructive: false }),
      inputSchema: z.object({ code: NonEmptyString.describe('Coupon code.'), confirmToken: confirmTokenParam }),
    },
    async ({ code, confirmToken }, ctx) => {
      const gate = await confirmWrite(ctx, {
        tool: 'mhlb_apply_coupon',
        action: 'coupon.apply',
        label: 'Apply coupon',
        target: code,
        request: { method: 'POST', path: '/parent/applyCoupon', query: { couponCode: code } },
        confirmToken,
      });
      if (gate) return gate;
      return minifiedResult(await client.write('/parent/applyCoupon', undefined, { couponCode: code }));
    },
  );

  server.registerTool(
    'mhlb_remove_coupon',
    {
      description: 'Remove the coupon currently applied to the account.' + CONFIRMS + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Remove coupon', readOnly: false, openWorld: true, destructive: false }),
      inputSchema: z.object({ confirmToken: confirmTokenParam }),
    },
    async ({ confirmToken }, ctx) => {
      const gate = await confirmWrite(ctx, {
        tool: 'mhlb_remove_coupon',
        action: 'coupon.remove',
        label: 'Remove coupon',
        target: '',
        request: { method: 'POST', path: '/parent/removeCoupon' },
        confirmToken,
      });
      if (gate) return gate;
      return minifiedResult(await client.write('/parent/removeCoupon'));
    },
  );
}
