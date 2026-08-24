import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { isPdf, MhlbClient } from '../src/client.js';
import {
  candidateNames,
  midpoint,
  outputDir,
  registerReportTools,
  writeWithoutClobbering,
} from '../src/tools/reports.js';
import { jsonResponse, testConfig, tokenHandler } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.MYHOTLUNCHBOX_OUTPUT_DIR;
});

const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'mhlb-out-'));
  dirs.push(d);
  return d;
};

/** A tiny but structurally real PDF, so the bytes written are checkable. */
const PDF = new TextEncoder().encode('%PDF-1.4\nreport-bytes\n%%EOF');

async function harness() {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return (
      tokenHandler()(url) ??
      new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } })
    );
  });
  const client = new MhlbClient(testConfig(), fetchSpy as unknown as typeof fetch);
  const h = await createTestHarness((server) => registerReportTools(server, client));
  return { h, fetchSpy };
}

describe('midpoint', () => {
  it('returns the date halfway through the range', () => {
    expect(midpoint('2026-09-01', '2026-09-30')).toBe('2026-09-15');
    expect(midpoint('2026-09-01', '2026-09-01')).toBe('2026-09-01');
  });
});

describe('outputDir', () => {
  it('defaults to the working directory', () => {
    expect(outputDir({})).toBe(process.cwd());
  });

  it('honours MYHOTLUNCHBOX_OUTPUT_DIR', () => {
    const d = scratch();
    expect(outputDir({ MYHOTLUNCHBOX_OUTPUT_DIR: d })).toBe(d);
  });
});

describe('candidateNames', () => {
  it('yields the plain name then numbered suffixes, preserving the extension', () => {
    const it_ = candidateNames('Lunch Calendar.pdf');
    expect([it_.next().value, it_.next().value, it_.next().value]).toEqual([
      'Lunch Calendar.pdf',
      'Lunch Calendar (2).pdf',
      'Lunch Calendar (3).pdf',
    ]);
  });

  it('handles a name with no extension', () => {
    const it_ = candidateNames('report');
    expect([it_.next().value, it_.next().value]).toEqual(['report', 'report (2)']);
  });
});

describe('writeWithoutClobbering', () => {
  it('uses the plain name when nothing is there', () => {
    const d = scratch();
    expect(writeWithoutClobbering(d, 'r.pdf', PDF)).toBe(join(d, 'r.pdf'));
  });

  it('suffixes rather than overwriting an existing report', () => {
    const d = scratch();
    writeFileSync(join(d, 'r.pdf'), 'original');
    expect(writeWithoutClobbering(d, 'r.pdf', PDF)).toBe(join(d, 'r (2).pdf'));
    // The pre-existing file must be untouched.
    expect(readFileSync(join(d, 'r.pdf'), 'utf8')).toBe('original');
  });

  it('gives every write on the same default name its own file', () => {
    // Note what this does and does not prove. `writeFileSync` is synchronous,
    // so a true interleaving cannot be constructed in-process and this would
    // also pass against the old existsSync-then-write version. The actual
    // guard against the TOCTOU race is the `wx` flag, asserted directly below;
    // this covers the naming walk under repeated use.
    const d = scratch();
    const bodies = Array.from({ length: 25 }, (_, i) => new TextEncoder().encode(`%PDF-${i}`));
    const paths = bodies.map((b) => writeWithoutClobbering(d, 'r.pdf', b));

    expect(new Set(paths).size).toBe(bodies.length);
    expect(readdirSync(d)).toHaveLength(bodies.length);
    // Every body survived, none overwritten.
    const written = new Set(paths.map((p) => readFileSync(p, 'utf8')));
    expect(written).toEqual(new Set(bodies.map((b) => new TextDecoder().decode(b))));
  });
});

describe('writeWithoutClobbering atomicity', () => {
  it('creates with the exclusive flag, so an existing file is never truncated', () => {
    // This is the property the `wx` flag buys: the existence check and the
    // create are one operation, so a file that appears between "choose a name"
    // and "write it" cannot be clobbered.
    const d = scratch();
    writeFileSync(join(d, 'r.pdf'), 'pre-existing');
    const written = writeWithoutClobbering(d, 'r.pdf', PDF);
    expect(written).not.toBe(join(d, 'r.pdf'));
    expect(readFileSync(join(d, 'r.pdf'), 'utf8')).toBe('pre-existing');
  });

  it('surfaces a non-EEXIST write failure instead of looping on it', () => {
    // A permissions error must not be mistaken for "name taken, try the next".
    const d = scratch();
    rmSync(d, { recursive: true, force: true });
    expect(() => writeWithoutClobbering(d, 'r.pdf', PDF)).toThrow();
  });
});

describe('report tools', () => {
  it('writes the PDF to disk and returns its path', async () => {
    const d = scratch();
    process.env.MYHOTLUNCHBOX_OUTPUT_DIR = d;
    const { h } = await harness();
    try {
      const body = parseToolResult<{ path: string; bytes: number; contentType: string }>(
        await h.callTool('mhlb_print_calendar', {
          startDate: '2026-09-01',
          endDate: '2026-09-30',
          studentIds: [7],
        }),
      );
      expect(body.contentType).toBe('application/pdf');
      expect(existsSync(body.path)).toBe(true);
      expect(readFileSync(body.path).subarray(0, 5).toString()).toBe('%PDF-');
      expect(body.bytes).toBe(PDF.byteLength);
    } finally {
      await h.close();
    }
  });

  it('sends start/end/middle/studentIds, not a naive date range', async () => {
    process.env.MYHOTLUNCHBOX_OUTPUT_DIR = scratch();
    const { h, fetchSpy } = await harness();
    try {
      await h.callTool('mhlb_print_calendar', {
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        studentIds: [7],
      });
      const call = fetchSpy.mock.calls.find((c) => String(c[0]).includes('printCalendar'));
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
        start: '2026-09-01',
        end: '2026-09-30',
        middle: '2026-09-15',
        studentIds: [7],
      });
    } finally {
      await h.close();
    }
  });

  it('returns base64 when inline is set', async () => {
    const { h } = await harness();
    try {
      const body = parseToolResult<{ base64: string; path?: string }>(
        await h.callTool('mhlb_print_calendar', {
          startDate: '2026-09-01',
          endDate: '2026-09-30',
          studentIds: [7],
          inline: true,
        }),
      );
      expect(body.path).toBeUndefined();
      expect(Buffer.from(body.base64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    } finally {
      await h.close();
    }
  });

  it('rejects a filename that would escape the output directory', async () => {
    process.env.MYHOTLUNCHBOX_OUTPUT_DIR = scratch();
    const { h } = await harness();
    try {
      const result = await h.callTool('mhlb_print_calendar', {
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        studentIds: [7],
        filename: '../escaped.pdf',
      });
      expect(result.isError).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('mhlb_print_orders refuses an empty studentIds list at the schema', async () => {
    const { h } = await harness();
    try {
      const result = await h.callTool('mhlb_print_orders', { date: '2026-09-14', studentIds: [] });
      expect(result.isError).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('mhlb_print_orders defaults orderStatus to Paid', async () => {
    process.env.MYHOTLUNCHBOX_OUTPUT_DIR = scratch();
    const { h, fetchSpy } = await harness();
    try {
      await h.callTool('mhlb_print_orders', { date: '2026-09-14', studentIds: [7] });
      const call = fetchSpy.mock.calls.find((c) => String(c[0]).includes('printOrders'));
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
        orderStatus: 1,
        eventDate: '2026-09-14',
        studentIds: [7],
      });
    } finally {
      await h.close();
    }
  });

  it('mhlb_print_transaction sends the transaction record plus isCreditType', async () => {
    process.env.MYHOTLUNCHBOX_OUTPUT_DIR = scratch();
    const { h, fetchSpy } = await harness();
    try {
      await h.callTool('mhlb_print_transaction', { transaction: { id: 5, total: 12 } });
      const call = fetchSpy.mock.calls.find((c) => String(c[0]).includes('printTransactions'));
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
        id: 5,
        total: 12,
        isCreditType: false,
      });
    } finally {
      await h.close();
    }
  });

  it('rejects a blank filename instead of writing a hidden ".pdf"', async () => {
    process.env.MYHOTLUNCHBOX_OUTPUT_DIR = scratch();
    const { h } = await harness();
    try {
      const result = await h.callTool('mhlb_print_calendar', {
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        studentIds: [7],
        filename: '   ',
      });
      expect(result.isError).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('refuses to return an oversized report inline', async () => {
    const big = new Uint8Array(800_000);
    big.set(new TextEncoder().encode('%PDF-1.4'));
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return (
        tokenHandler()(url) ??
        new Response(big, { status: 200, headers: { 'content-type': 'application/pdf' } })
      );
    });
    const client = new MhlbClient(testConfig(), fetchSpy as unknown as typeof fetch);
    const h = await createTestHarness((server) => registerReportTools(server, client));
    try {
      const result = await h.callTool('mhlb_print_calendar', {
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        studentIds: [7],
        inline: true,
      });
      expect(result.isError).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('mhlb_print_calendar refuses an empty studentIds list at the schema', async () => {
    // Verified live: the endpoint 500s on an empty or omitted list — there is
    // no "all students" default on either print endpoint.
    const { h } = await harness();
    try {
      const result = await h.callTool('mhlb_print_calendar', {
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        studentIds: [],
      });
      expect(result.isError).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('reports an HTML 200 as a lapsed session, not a PDF written to disk', async () => {
    process.env.MYHOTLUNCHBOX_OUTPUT_DIR = scratch();
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return (
        tokenHandler()(url) ??
        new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } })
      );
    });
    const client = new MhlbClient(testConfig(), fetchSpy as unknown as typeof fetch);
    const h = await createTestHarness((server) => registerReportTools(server, client));
    try {
      const result = await h.callTool('mhlb_print_calendar', {
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        studentIds: [7],
      });
      expect(result.isError).toBe(true);
    } finally {
      await h.close();
    }
  });

  it.each([
    ['text/plain', 'text/plain'],
    ['no content-type at all', null],
    ['a JSON error body served as octet-stream', 'application/octet-stream'],
  ])('rejects a non-PDF 200 (%s) instead of writing it to disk', async (_label, ct) => {
    process.env.MYHOTLUNCHBOX_OUTPUT_DIR = scratch();
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (tokenHandler()(url)) return tokenHandler()(url) as Response;
      return new Response('not a pdf at all', {
        status: 200,
        ...(ct ? { headers: { 'content-type': ct } } : {}),
      });
    });
    const client = new MhlbClient(testConfig(), fetchSpy as unknown as typeof fetch);
    const h = await createTestHarness((server) => registerReportTools(server, client));
    try {
      const result = await h.callTool('mhlb_print_calendar', {
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        studentIds: [7],
      });
      expect(result.isError).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('isPdf checks the bytes, not the header', () => {
    expect(isPdf(new TextEncoder().encode('%PDF-1.4 ...'))).toBe(true);
    expect(isPdf(new TextEncoder().encode('<html>'))).toBe(false);
    expect(isPdf(new TextEncoder().encode('%PD'))).toBe(false);
    expect(isPdf(new Uint8Array(0))).toBe(false);
  });

  it('classifies a 429 on the binary path the same as on the JSON path', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return (
        tokenHandler()(url) ??
        new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })
      );
    });
    const client = new MhlbClient(testConfig(), fetchSpy as unknown as typeof fetch);
    const err = await client
      .writeBinary('/parentReports/printCalendar', {})
      .catch((e: Error & { retryAfterSeconds?: number }) => e);
    expect((err as Error).message).toMatch(/rate/i);
    expect((err as { retryAfterSeconds?: number }).retryAfterSeconds).toBe(30);
  });

  it('classifies a 403 on the binary path as a role mismatch', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return tokenHandler()(url) ?? new Response('denied', { status: 403 });
    });
    const client = new MhlbClient(testConfig(), fetchSpy as unknown as typeof fetch);
    const err = await client
      .writeBinary('/parentReports/printCalendar', {})
      .catch((e: Error & { hint?: string }) => e);
    expect((err as { hint?: string }).hint).toMatch(/not available to a parent account/i);
  });

  it('explains a 500 as a no-match rather than "service is down"', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return tokenHandler()(url) ?? new Response('boom', { status: 500 });
    });
    const client = new MhlbClient(testConfig(), fetchSpy as unknown as typeof fetch);
    const err = await client
      .writeBinary('/parentReports/printOrders', {})
      .catch((e: Error & { hint?: string }) => e);
    expect((err as Error).message).toContain('failed to generate the report');
    expect((err as { hint?: string }).hint).toMatch(/studentIds is non-empty/);
  });
});
