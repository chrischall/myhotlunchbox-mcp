import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { MhlbClient } from '../src/client.js';
import { midpoint, nonClobberingPath, outputDir, registerReportTools } from '../src/tools/reports.js';
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

describe('nonClobberingPath', () => {
  it('returns the plain name when nothing is there', () => {
    const d = scratch();
    expect(nonClobberingPath(d, 'r.pdf')).toBe(join(d, 'r.pdf'));
  });

  it('suffixes rather than overwriting an existing report', () => {
    const d = scratch();
    writeFileSync(join(d, 'r.pdf'), 'x');
    expect(nonClobberingPath(d, 'r.pdf')).toBe(join(d, 'r (2).pdf'));
    writeFileSync(join(d, 'r (2).pdf'), 'x');
    expect(nonClobberingPath(d, 'r.pdf')).toBe(join(d, 'r (3).pdf'));
  });
});

describe('report tools', () => {
  it('writes the PDF to disk and returns its path', async () => {
    const d = scratch();
    process.env.MYHOTLUNCHBOX_OUTPUT_DIR = d;
    const { h } = await harness();
    try {
      const body = parseToolResult<{ path: string; bytes: number; contentType: string }>(
        await h.callTool('mhlb_print_calendar', { startDate: '2026-09-01', endDate: '2026-09-30' }),
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
