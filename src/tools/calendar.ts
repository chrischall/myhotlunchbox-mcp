import { toolAnnotations, PositiveInt, IsoDate } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MhlbClient } from '../client.js';
import { minifiedResult } from './_shared.js';

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
      },
    },
    // Field names are `start`/`end`, captured from the live app. Sending
    // `startDate`/`endDate` returns 200 with an empty `events` array — a silent
    // wrong answer, not an error.
    async ({ startDate, endDate }) =>
      minifiedResult(await client.write('/calendar/studentSchoolData', { start: startDate, end: endDate })),
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
      minifiedResult(await client.get('/calendar/studentOrderItems', { studentId, date })),
  );

}
