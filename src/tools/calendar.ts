import { toolAnnotations, PositiveInt, IsoDate } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MhlbClient } from '../client.js';
import { jsonResult } from './_shared.js';

export function registerCalendarTools(server: McpServer, client: MhlbClient): void {
  server.registerTool(
    'mhlb_get_calendar',
    {
      description:
        'Get the lunch calendar for the account over a date range: which days are open for ordering, already ' +
        'ordered, paid, in the cart, subscribed or closed, per student. This is what the Lunch Calendar page shows.',
      annotations: toolAnnotations({ title: 'Get lunch calendar', openWorld: true }),
      inputSchema: {
        startDate: IsoDate.describe('First day to include (YYYY-MM-DD).'),
        endDate: IsoDate.describe('Last day to include (YYYY-MM-DD).'),
        studentIds: z
          .array(PositiveInt)
          .optional()
          .describe('Limit to these students. Defaults to every student on the account.'),
      },
    },
    async ({ startDate, endDate, studentIds }) =>
      jsonResult(
        await client.write('/calendar/studentSchoolData', {
          startDate,
          endDate,
          ...(studentIds ? { studentIds } : {}),
        }),
      ),
  );

  server.registerTool(
    'mhlb_get_day',
    {
      description:
        'Get what a student has ordered on one specific date — the items, sizes, quantities, add-ons and prices.',
      annotations: toolAnnotations({ title: 'Get a day’s order', openWorld: true }),
      inputSchema: {
        studentId: PositiveInt.describe('Student id from mhlb_list_students.'),
        date: IsoDate.describe('The day to look at (YYYY-MM-DD).'),
      },
    },
    async ({ studentId, date }) =>
      jsonResult(await client.get('/calendar/studentOrderItems', { studentId, date })),
  );

  server.registerTool(
    'mhlb_next_delivery',
    {
      description: 'Get the next scheduled lunch delivery for the account — date, school, and what is coming.',
      annotations: toolAnnotations({ title: 'Next delivery', openWorld: true }),
      inputSchema: {},
    },
    async () => jsonResult(await client.get('/deliveryInfo/nextDelivery')),
  );

  server.registerTool(
    'mhlb_list_upcoming_deliveries',
    {
      description: 'List upcoming lunch deliveries for the account.',
      annotations: toolAnnotations({ title: 'List upcoming deliveries', openWorld: true }),
      inputSchema: {},
    },
    async () => jsonResult(await client.get('/deliveryInfo/upcomingDeliveries')),
  );

  server.registerTool(
    'mhlb_list_past_deliveries',
    {
      description: 'List past (archived) lunch deliveries for the account.',
      annotations: toolAnnotations({ title: 'List past deliveries', openWorld: true }),
      inputSchema: {},
    },
    async () => jsonResult(await client.get('/deliveryInfo/archivedDeliveries')),
  );

  server.registerTool(
    'mhlb_list_vendors',
    {
      description:
        'List the food vendors matched to the account’s schools — who is actually able to deliver lunch.',
      annotations: toolAnnotations({ title: 'List matched vendors', openWorld: true }),
      inputSchema: {},
    },
    async () => jsonResult(await client.get('/calendar/viewMatchedVendors')),
  );
}
