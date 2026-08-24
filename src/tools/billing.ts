import { toolAnnotations, PositiveInt, NonEmptyString, schemaConfirm } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MhlbClient } from '../client.js';
import { jsonResult, preview, UNVERIFIED } from './_shared.js';

export function registerBillingTools(server: McpServer, client: MhlbClient): void {
  server.registerTool(
    'mhlb_list_transactions',
    {
      description: 'List payment transactions on the account — date, amount, and what was paid for.',
      annotations: toolAnnotations({ title: 'List transactions', openWorld: true }),
      inputSchema: {
        period: z.string().optional().describe('Ordering period to scope to, from mhlb_get_cart_tabs.'),
        studentId: PositiveInt.optional().describe('Limit to one student.'),
      },
    },
    async ({ period, studentId }) =>
      jsonResult(await client.get('/event/transactionsList', { selectedPeriod: period, selectedStudentId: studentId })),
  );

  server.registerTool(
    'mhlb_get_transaction',
    {
      description: 'Get the line-item detail of one transaction — which lunches it paid for.',
      annotations: toolAnnotations({ title: 'Get transaction', openWorld: true }),
      inputSchema: { transactionId: PositiveInt.describe('Transaction id from mhlb_list_transactions.') },
    },
    async ({ transactionId }) =>
      jsonResult(await client.get('/event/transactionDetails', { transactionId })),
  );

  server.registerTool(
    'mhlb_list_subscriptions',
    {
      description:
        'List upcoming lunch subscriptions — the recurring orders that will be placed and charged automatically.',
      annotations: toolAnnotations({ title: 'List subscriptions', openWorld: true }),
      inputSchema: { period: z.string().optional().describe('Ordering period to scope to.') },
    },
    async ({ period }) => jsonResult(await client.get('/event/upcomingSubscriptions', { period })),
  );

  server.registerTool(
    'mhlb_get_subscription_settings',
    {
      description: 'Get the account’s subscription configuration — whether recurring ordering is on, and its terms.',
      annotations: toolAnnotations({ title: 'Get subscription settings', openWorld: true }),
      inputSchema: {},
    },
    async () => jsonResult(await client.get('/event/subscription')),
  );

  server.registerTool(
    'mhlb_set_subscription_enabled',
    {
      description:
        'Turn recurring lunch subscriptions on or off for the account. Turning it ON means future lunches are ' +
        'ordered and charged automatically.' + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Enable/disable subscriptions', readOnly: false, openWorld: true }),
      inputSchema: {
        enabled: z.boolean().describe('true to enable recurring subscriptions, false to disable.'),
        confirm: schemaConfirm,
      },
    },
    async ({ enabled, confirm }) => {
      if (!confirm) {
        return preview(
          `${enabled ? 'Enable' : 'Disable'} subscriptions`,
          { method: 'POST', path: '/parent/changeSubscriptionStatus', query: { isEnableSubscription: enabled } },
          enabled ? ['Enabling means future lunches are ordered and charged automatically.'] : [],
        );
      }
      return jsonResult(
        await client.write('/parent/changeSubscriptionStatus', undefined, { isEnableSubscription: enabled }),
      );
    },
  );

  server.registerTool(
    'mhlb_unsubscribe_order',
    {
      description: 'Stop a recurring subscription for a specific lunch order.' + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Unsubscribe an order', readOnly: false, openWorld: true }),
      inputSchema: {
        order: z
          .record(z.string(), z.unknown())
          .describe('The subscription identifier payload, from mhlb_list_subscriptions.'),
        confirm: schemaConfirm,
      },
    },
    // The upstream route really is spelled `unsubcribeOrder`.
    async ({ order, confirm }) => {
      if (!confirm) return preview('Unsubscribe order', { method: 'POST', path: '/event/unsubcribeOrder', body: order });
      return jsonResult(await client.write('/event/unsubcribeOrder', order));
    },
  );

  server.registerTool(
    'mhlb_list_gift_cards',
    {
      description: 'List gift cards on the account — codes, balances and status.',
      annotations: toolAnnotations({ title: 'List gift cards', openWorld: true }),
      inputSchema: {},
    },
    async () => jsonResult(await client.get('/parent/giftCardDataTables')),
  );

  server.registerTool(
    'mhlb_apply_gift_card',
    {
      description: 'Redeem a gift card code onto the account balance.' + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Apply gift card', readOnly: false, openWorld: true }),
      inputSchema: { code: NonEmptyString.describe('Gift card code.'), confirm: schemaConfirm },
    },
    async ({ code, confirm }) => {
      if (!confirm) {
        return preview('Apply gift card', { method: 'POST', path: '/parent/applyGiftCard', query: { giftCardCode: code } });
      }
      return jsonResult(await client.write('/parent/applyGiftCard', undefined, { giftCardCode: code }));
    },
  );

  server.registerTool(
    'mhlb_get_coupon',
    {
      description: 'Get the coupon currently applied to the account, if any.',
      annotations: toolAnnotations({ title: 'Get applied coupon', openWorld: true }),
      inputSchema: {},
    },
    async () => jsonResult(await client.get('/parent/coupon')),
  );

  server.registerTool(
    'mhlb_apply_coupon',
    {
      description: 'Apply a coupon code to the account.' + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Apply coupon', readOnly: false, openWorld: true }),
      inputSchema: { code: NonEmptyString.describe('Coupon code.'), confirm: schemaConfirm },
    },
    async ({ code, confirm }) => {
      if (!confirm) {
        return preview('Apply coupon', { method: 'POST', path: '/parent/applyCoupon', query: { couponCode: code } });
      }
      return jsonResult(await client.write('/parent/applyCoupon', undefined, { couponCode: code }));
    },
  );

  server.registerTool(
    'mhlb_remove_coupon',
    {
      description: 'Remove the coupon currently applied to the account.' + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Remove coupon', readOnly: false, openWorld: true }),
      inputSchema: { confirm: schemaConfirm },
    },
    async ({ confirm }) => {
      if (!confirm) return preview('Remove coupon', { method: 'POST', path: '/parent/removeCoupon' });
      return jsonResult(await client.write('/parent/removeCoupon'));
    },
  );
}
