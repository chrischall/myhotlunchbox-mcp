import { describe, expect, it, vi } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { MhlbClient } from '../src/client.js';
import { registerBillingTools } from '../src/tools/billing.js';
import { jsonResponse, testConfig, tokenHandler } from './helpers.js';

// Synthetic codes — never a real card.
const CODE_A = 'TESTGIFT00001111';
const CODE_B = 'TESTGIFT00002222';

/** A DataTables-shaped response, as `/parent/giftCardDataTables` returns. */
const UPSTREAM = {
  draw: 1,
  recordsTotal: 2,
  data: [
    { id: 11, giftCardCode: CODE_A, balance: 12.5, status: 'Active', appliedDate: '2026-09-01' },
    { id: 12, code: CODE_B, amount: 20, status: 'Used', statusCode: 3 },
  ],
};

async function call(args: Record<string, unknown>) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return tokenHandler()(url) ?? jsonResponse(UPSTREAM);
  });
  const client = new MhlbClient(testConfig(), fetchSpy as unknown as typeof fetch);
  const h = await createTestHarness((server) => registerBillingTools(server, client));
  try {
    const result = await h.callTool('mhlb_list_gift_cards', args);
    expect(result.isError).toBeFalsy();
    return (result.content as Array<{ text: string }>)[0]!.text;
  } finally {
    await h.close();
  }
}

describe('mhlb_list_gift_cards', () => {
  it('masks gift-card codes to the last 4 by default', async () => {
    const text = await call({});
    expect(text).not.toContain(CODE_A);
    expect(text).not.toContain(CODE_B);
    const parsed = JSON.parse(text);
    expect(parsed.data[0]).toMatchObject({ id: 11, giftCardCode: '****1111', balance: 12.5, status: 'Active' });
    expect(parsed.data[1]).toMatchObject({ id: 12, code: '****2222', amount: 20, status: 'Used', statusCode: 3 });
    expect(parsed.recordsTotal).toBe(2);
  });

  it('returns the full codes only when revealCodes is true', async () => {
    const text = await call({ revealCodes: true });
    expect(text).toContain(CODE_A);
    expect(text).toContain(CODE_B);
  });
});

describe('maskGiftCardCodes', () => {
  it('masks code-bearing keys only, at any depth', async () => {
    const { maskGiftCardCodes } = await import('../src/tools/billing.js');
    expect(
      maskGiftCardCodes([{ cardNumber: 'ABCD99998888', giftCardNo: 12345678, number: 7, statusCode: 2, nested: { code: 'XYZ00001234' } }]),
    ).toEqual([{ cardNumber: '****8888', giftCardNo: '****5678', number: 7, statusCode: 2, nested: { code: '****1234' } }]);
  });
});

describe('maskCode', () => {
  it('shows the last 4 of a normal-length code', async () => {
    const { maskCode } = await import('../src/tools/billing.js');
    expect(maskCode('TESTGIFT00001111')).toBe('****1111');
    expect(maskCode('12345678')).toBe('****5678');
  });

  it('never reveals a short code in full — at most half of it shows', async () => {
    const { maskCode } = await import('../src/tools/billing.js');
    expect(maskCode('1234')).toBe('****34');
    expect(maskCode('ABC')).toBe('****C');
    expect(maskCode('Z')).toBe('****');
    expect(maskCode('')).toBe('****');
    for (const code of ['A', 'AB', 'ABC', 'ABCD', 'ABCDE', 'ABCDEFG']) {
      expect(maskCode(code)).not.toContain(code);
    }
  });
});
