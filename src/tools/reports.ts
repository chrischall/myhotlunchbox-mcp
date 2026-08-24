import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { McpToolError, readEnvVar, toolAnnotations, PositiveInt, IsoDate } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MhlbClient } from '../client.js';
import { jsonResult } from './_shared.js';

/**
 * The `/parentReports/print*` endpoints are declared `responseType: 'blob'` in
 * the site's own client and stream a wkhtmltopdf-generated PDF. They generate a
 * document rather than changing account state, so they are reads and carry no
 * `confirm` — but they do write a local file, so the destination is
 * configurable and never silently overwrites.
 */

const MAX_INLINE_BYTES = 750_000;

/** Where PDFs land. `MYHOTLUNCHBOX_OUTPUT_DIR`, else the working directory. */
export function outputDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = readEnvVar('MYHOTLUNCHBOX_OUTPUT_DIR', { env });
  return configured ? resolve(configured) : process.cwd();
}

/** Candidate names in order: `r.pdf`, `r (2).pdf`, `r (3).pdf`, … */
export function* candidateNames(filename: string): Generator<string> {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  yield filename;
  for (let n = 2; ; n += 1) yield `${stem} (${n})${ext}`;
}

/** How many suffixed names to try before giving up. */
const MAX_NAME_ATTEMPTS = 1000;

/**
 * Write the report without ever overwriting an existing file.
 *
 * `existsSync` followed by a default-flag `writeFileSync` is a TOCTOU race:
 * two concurrent print calls landing on the same default filename both see it
 * free and the second silently clobbers the first. `wx` makes the check and
 * the create one atomic operation, so the loser retries the next name instead.
 */
export function writeWithoutClobbering(dir: string, filename: string, bytes: Uint8Array): string {
  let attempts = 0;
  for (const name of candidateNames(filename)) {
    if (attempts >= MAX_NAME_ATTEMPTS) break;
    attempts += 1;
    const candidate = join(dir, name);
    try {
      writeFileSync(candidate, bytes, { flag: 'wx' });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new McpToolError(
    `Could not find a free filename for "${filename}" in ${dir} after ${MAX_NAME_ATTEMPTS} attempts.`,
    { hint: 'Clear out old reports, pass an explicit filename, or set MYHOTLUNCHBOX_OUTPUT_DIR elsewhere.' },
  );
}

/** Reject a filename that would escape the output directory. */
function safeName(name: string): string {
  if (name.trim() === '') {
    throw new McpToolError('Report filename is empty.', {
      hint: 'Omit filename to take the default, or pass a non-blank name.',
    });
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..') || isAbsolute(name)) {
    throw new McpToolError(`Unsafe report filename: ${name}`, {
      hint: 'filename must be a bare name, with no path separators.',
    });
  }
  return name.endsWith('.pdf') ? name : `${name}.pdf`;
}

function deliver(
  bytes: Uint8Array,
  contentType: string,
  filename: string,
  inline: boolean,
): ReturnType<typeof jsonResult> {
  if (inline) {
    if (bytes.byteLength > MAX_INLINE_BYTES) {
      throw new McpToolError(
        `Report is ${bytes.byteLength} bytes — too large to return inline (limit ${MAX_INLINE_BYTES}).`,
        { hint: 'Call again with inline: false to write it to a file instead.' },
      );
    }
    return jsonResult({
      filename,
      contentType,
      bytes: bytes.byteLength,
      base64: Buffer.from(bytes).toString('base64'),
    });
  }

  const dir = outputDir();
  let path: string;
  try {
    mkdirSync(dir, { recursive: true });
    path = writeWithoutClobbering(dir, filename, bytes);
  } catch (cause) {
    // Let an already-actionable error through rather than burying it under a
    // generic permissions message.
    if (cause instanceof McpToolError) throw cause;
    throw new McpToolError(`Could not write the report into ${dir}.`, {
      hint: 'Set MYHOTLUNCHBOX_OUTPUT_DIR to a writable directory, or call again with inline: true.',
      cause,
    });
  }
  return jsonResult({ path, contentType, bytes: bytes.byteLength });
}

/** The midpoint date the calendar report uses to title the PDF. */
export function midpoint(start: string, end: string): string {
  const mid = new Date((Date.parse(start) + Date.parse(end)) / 2);
  return mid.toISOString().slice(0, 10);
}

const inlineFlag = z
  .boolean()
  .optional()
  .describe('Return the PDF as base64 in the result instead of writing it to a file. Default false.');

export function registerReportTools(server: McpServer, client: MhlbClient): void {
  server.registerTool(
    'mhlb_print_calendar',
    {
      description:
        'Generate the printable lunch calendar PDF for a date range. Writes the PDF to disk and returns its ' +
        'path (or the bytes inline with inline: true).',
      annotations: toolAnnotations({ title: 'Print lunch calendar', readOnly: false, openWorld: true }),
      inputSchema: {
        startDate: IsoDate.describe('First day to include (YYYY-MM-DD).'),
        endDate: IsoDate.describe('Last day to include (YYYY-MM-DD).'),
        studentIds: z
          .array(PositiveInt)
          .min(1)
          .describe(
            'Students to include — at least one, from mhlb_list_students. There is no "all students" ' +
            'default: an empty or omitted list makes the endpoint fail.',
          ),
        filename: z.string().optional().describe('Output filename. Defaults to "Lunch Calendar.pdf".'),
        inline: inlineFlag,
      },
    },
    async ({ startDate, endDate, studentIds, filename, inline }) => {
      const { bytes, contentType } = await client.writeBinary('/parentReports/printCalendar', {
        start: startDate,
        end: endDate,
        middle: midpoint(startDate, endDate),
        studentIds,
      });
      return deliver(bytes, contentType, safeName(filename ?? 'Lunch Calendar.pdf'), inline ?? false);
    },
  );

  server.registerTool(
    'mhlb_print_orders',
    {
      description:
        'Generate the printable order-details PDF for a single lunch date. Note this is one date, not a range, ' +
        'and studentIds is required — the endpoint fails if it is empty, or if no order matches the date and ' +
        'status you ask for. Get both from mhlb_get_calendar.',
      annotations: toolAnnotations({ title: 'Print order details', readOnly: false, openWorld: true }),
      inputSchema: {
        date: IsoDate.describe('The lunch date to report on (YYYY-MM-DD).'),
        orderStatus: z
          .union([z.literal(0), z.literal(1), z.literal(2)])
          .default(1)
          .describe('Order status to report: 0 = Pending, 1 = Paid (default), 2 = Credited.'),
        studentIds: z
          .array(PositiveInt)
          .min(1)
          .describe('Students to include — at least one. An empty list makes the endpoint fail.'),
        filename: z.string().optional().describe('Output filename. Defaults to "Orders Details <date>.pdf".'),
        inline: inlineFlag,
      },
    },
    async ({ date, orderStatus, studentIds, filename, inline }) => {
      const { bytes, contentType } = await client.writeBinary('/parentReports/printOrders', {
        orderStatus,
        eventDate: date,
        studentIds,
      });
      return deliver(bytes, contentType, safeName(filename ?? `Orders Details ${date}.pdf`), inline ?? false);
    },
  );

  server.registerTool(
    'mhlb_print_transaction',
    {
      description:
        'Generate the printable receipt PDF for one transaction. Pass the transaction object from ' +
        'mhlb_get_transaction — the endpoint renders that record, it does not look one up by id.',
      annotations: toolAnnotations({ title: 'Print transaction receipt', readOnly: false, openWorld: true }),
      inputSchema: {
        transaction: z
          .record(z.string(), z.unknown())
          .describe('The transaction detail object, as returned by mhlb_get_transaction.'),
        isCreditType: z.boolean().optional().describe('Render as a credit rather than a payment. Default false.'),
        filename: z.string().optional().describe('Output filename. Defaults to "Transaction.pdf".'),
        inline: inlineFlag,
      },
    },
    async ({ transaction, isCreditType, filename, inline }) => {
      const { bytes, contentType } = await client.writeBinary('/parentReports/printTransactions', {
        ...transaction,
        isCreditType: isCreditType ?? false,
      });
      return deliver(bytes, contentType, safeName(filename ?? 'Transaction.pdf'), inline ?? false);
    },
  );
}
