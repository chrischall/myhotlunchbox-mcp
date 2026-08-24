import { toolAnnotations, PositiveInt, IsoDate, schemaConfirm } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MhlbClient } from '../client.js';
import { jsonResult, preview, UNVERIFIED } from './_shared.js';

/**
 * Ordering is read-modify-write throughout: `GET /event/createOrder` and
 * `GET /event/editOrder` return a populated model (menu items, sizes, add-ons,
 * quantities, repeat settings) and the matching POST takes it back. Passing the
 * model through verbatim avoids guessing at field names the compiled client
 * only ever handles opaquely.
 */
const OrderModel = z
  .record(z.string(), z.unknown())
  .describe('The order model, as returned by mhlb_get_order_form / mhlb_get_order, with quantities and options edited.');

/**
 * Cancelling and unsubscribing take a small identifier payload — NOT the order
 * model the create/edit pair round-trips. Captured from the site's own
 * `order-mixin`, which builds exactly
 * `{orderId, isRepeated, eventDate, studentId, isSubscribed}`.
 *
 * Spelling this out rather than accepting an opaque record is the point: an
 * agent handed "the order payload" sends the 40-field model, which is not what
 * these endpoints read.
 */
export const OrderRefShape = {
  orderId: PositiveInt.describe('Order id, from mhlb_get_calendar or mhlb_get_cart.'),
  eventDate: IsoDate.describe('The lunch date of that order (YYYY-MM-DD).'),
  studentId: PositiveInt.describe('Student the order belongs to.'),
  isRepeated: z
    .boolean()
    .optional()
    .describe('true acts on the whole recurring series, not just this date. Defaults to false.'),
  isSubscribed: z
    .boolean()
    .optional()
    .describe(
      'Whether the order is a subscription. Defaults to false for mhlb_delete_order and true for ' +
      'mhlb_unsubscribe_order, matching what each is for.',
    ),
};

export function orderRefBody(ref: {
  orderId: number;
  eventDate: string;
  studentId: number;
  isRepeated?: boolean;
  isSubscribed?: boolean;
}): Record<string, unknown> {
  return {
    orderId: ref.orderId,
    eventDate: ref.eventDate,
    studentId: ref.studentId,
    isRepeated: ref.isRepeated ?? false,
    isSubscribed: ref.isSubscribed ?? false,
  };
}

export function registerOrderTools(server: McpServer, client: MhlbClient): void {
  server.registerTool(
    'mhlb_get_cart',
    {
      description:
        'Get the shopping cart — lunches added but not yet paid for. Filter by order status and ordering period, ' +
        'or narrow to one student.',
      annotations: toolAnnotations({ title: 'Get cart', openWorld: true }),
      inputSchema: {
        orderStatus: z.string().optional().describe('Status tab to show, e.g. from mhlb_get_cart_tabs.'),
        period: z.string().optional().describe('Ordering period value from mhlb_get_cart_tabs.'),
        studentId: PositiveInt.optional().describe('Limit to one student.'),
      },
    },
    async ({ orderStatus, period, studentId }) =>
      jsonResult(
        await client.get('/event/shoppingCart', {
          orderStatus,
          selectedPeriod: period,
          selectedStudentId: studentId,
        }),
      ),
  );

  server.registerTool(
    'mhlb_get_cart_tabs',
    {
      description:
        'Get the valid filter values for mhlb_get_cart — the ordering periods (semesters) and status tabs, ' +
        'with which one is selected by default. Call this before filtering the cart.',
      annotations: toolAnnotations({ title: 'Get cart filters', openWorld: true }),
      inputSchema: {
        tabName: z.string().optional().describe('Status tab whose counts to compute.'),
        period: z.string().optional().describe('Ordering period to scope the tabs to.'),
        studentId: PositiveInt.optional().describe('Limit to one student.'),
      },
    },
    async ({ tabName, period, studentId }) =>
      jsonResult(
        await client.get('/event/ShoppingCartBaseData', {
          shopingCartTabsName: tabName,
          selectedPeriod: period,
          selectedStudentId: studentId,
        }),
      ),
  );

  server.registerTool(
    'mhlb_get_menu',
    {
      description:
        'Get the orderable menu for one student on one date — the vendor, items, sizes, add-ons, prices and ' +
        'the ordering deadline. This is the read half of placing an order.',
      annotations: toolAnnotations({ title: 'Get menu for a day', openWorld: true }),
      inputSchema: {
        studentId: PositiveInt.describe('Student id from mhlb_list_students.'),
        date: IsoDate.describe('The lunch date (YYYY-MM-DD).'),
      },
    },
    async ({ studentId, date }) =>
      jsonResult(await client.get('/event/orderBaseData', { studentId, eventDate: date })),
  );

  server.registerTool(
    'mhlb_get_order_form',
    {
      description:
        'Get the blank order model for a student on a specific lunch event — the exact structure that ' +
        'mhlb_create_order expects back, pre-populated with the available items.',
      annotations: toolAnnotations({ title: 'Get order form', openWorld: true }),
      inputSchema: {
        eventId: PositiveInt.describe('Lunch event id, from mhlb_get_menu or mhlb_get_calendar.'),
        studentId: PositiveInt.describe('Student id from mhlb_list_students.'),
      },
    },
    async ({ eventId, studentId }) =>
      jsonResult(await client.get('/event/createOrder', { eventId, studentId })),
  );

  server.registerTool(
    'mhlb_get_order',
    {
      description:
        'Get an existing order in editable form — the model mhlb_update_order expects back.',
      annotations: toolAnnotations({ title: 'Get order', openWorld: true }),
      inputSchema: {
        orderId: PositiveInt.optional().describe('Order id, when you have one.'),
        eventId: PositiveInt.optional().describe('Lunch event id.'),
        studentId: PositiveInt.optional().describe('Student id.'),
      },
    },
    async ({ orderId, eventId, studentId }) =>
      jsonResult(await client.get('/event/editOrder', { orderId, eventId, studentId })),
  );

  server.registerTool(
    'mhlb_create_order',
    {
      description:
        'Place a lunch order into the cart. Call mhlb_get_order_form first and send that model back with ' +
        'quantities set. This adds to the cart — it does not pay; use mhlb_checkout for that.' + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Create order', readOnly: false, openWorld: true }),
      inputSchema: { order: OrderModel, confirm: schemaConfirm },
    },
    async ({ order, confirm }) => {
      if (!confirm) {
        return preview('Create order', { method: 'POST', path: '/event/createOrder', body: order }, [
          'This adds the lunch to the cart. Payment is a separate step (mhlb_checkout).',
        ]);
      }
      return jsonResult(await client.write('/event/createOrder', order));
    },
  );

  server.registerTool(
    'mhlb_update_order',
    {
      description:
        'Change an existing lunch order. Call mhlb_get_order first and send that model back with your edits — ' +
        'the endpoint replaces the whole order.' + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Update order', readOnly: false, openWorld: true }),
      inputSchema: { order: OrderModel, confirm: schemaConfirm },
    },
    async ({ order, confirm }) => {
      if (!confirm) {
        return preview('Update order', { method: 'POST', path: '/event/editOrder', body: order }, [
          'This is a whole-order replace: items missing from `order` are removed, not preserved.',
        ]);
      }
      return jsonResult(await client.write('/event/editOrder', order));
    },
  );

  server.registerTool(
    'mhlb_delete_order',
    {
      description:
        'Cancel a lunch order. If it was already paid for, the refund behaviour is whatever My Hot Lunchbox ' +
        'applies — this tool does not control it.' + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Delete order', readOnly: false, openWorld: true }),
      inputSchema: { ...OrderRefShape, confirm: schemaConfirm },
    },
    async ({ confirm, ...ref }) => {
      const body = orderRefBody(ref);
      if (!confirm) {
        return preview('Delete order', { method: 'POST', path: '/event/deleteOrder', body }, [
          'Cancelling a paid order may or may not refund it — verify on the site afterwards.',
          'isRepeated: true removes the whole recurring series, not just this date.',
        ]);
      }
      return jsonResult(await client.write('/event/deleteOrder', body));
    },
  );
}
