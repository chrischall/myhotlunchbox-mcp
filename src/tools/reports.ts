import { toolAnnotations, PositiveInt, IsoDate } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MhlbClient } from '../client.js';
import { jsonResult } from './_shared.js';

/**
 * The print endpoints render a PDF server-side and return a reference to it.
 * They are POSTs but produce no account state, so they are reads for gating
 * purposes and carry no `confirm`.
 */
export function registerReportTools(server: McpServer, client: MhlbClient): void {
  server.registerTool(
    'mhlb_print_orders',
    {
      description:
        'Generate the printable orders report for a date range — the same PDF the site’s Print button produces.',
      annotations: toolAnnotations({ title: 'Print orders report', openWorld: true }),
      inputSchema: {
        startDate: IsoDate.describe('First day to include (YYYY-MM-DD).'),
        endDate: IsoDate.describe('Last day to include (YYYY-MM-DD).'),
        studentIds: z.array(PositiveInt).optional().describe('Limit to these students.'),
      },
    },
    async ({ startDate, endDate, studentIds }) =>
      jsonResult(
        await client.write('/parentReports/printOrders', {
          startDate,
          endDate,
          ...(studentIds ? { studentIds } : {}),
        }),
      ),
  );

  server.registerTool(
    'mhlb_print_calendar',
    {
      description: 'Generate the printable lunch calendar for a date range.',
      annotations: toolAnnotations({ title: 'Print calendar', openWorld: true }),
      inputSchema: {
        startDate: IsoDate.describe('First day to include (YYYY-MM-DD).'),
        endDate: IsoDate.describe('Last day to include (YYYY-MM-DD).'),
        studentIds: z.array(PositiveInt).optional().describe('Limit to these students.'),
      },
    },
    async ({ startDate, endDate, studentIds }) =>
      jsonResult(
        await client.write('/parentReports/printCalendar', {
          startDate,
          endDate,
          ...(studentIds ? { studentIds } : {}),
        }),
      ),
  );

  server.registerTool(
    'mhlb_print_transactions',
    {
      description: 'Generate the printable transactions report for a date range.',
      annotations: toolAnnotations({ title: 'Print transactions', openWorld: true }),
      inputSchema: {
        startDate: IsoDate.describe('First day to include (YYYY-MM-DD).'),
        endDate: IsoDate.describe('Last day to include (YYYY-MM-DD).'),
      },
    },
    async ({ startDate, endDate }) =>
      jsonResult(await client.write('/parentReports/printTransactions', { startDate, endDate })),
  );
}
