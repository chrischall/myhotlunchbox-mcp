import { describe, expect, it, vi } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { MhlbClient } from '../src/client.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerStudentTools } from '../src/tools/students.js';
import { registerCalendarTools, briefLine } from '../src/tools/calendar.js';
import { registerOrderTools } from '../src/tools/orders.js';
import { registerBillingTools } from '../src/tools/billing.js';
import { registerCheckoutTools } from '../src/tools/checkout.js';
import { registerReportTools } from '../src/tools/reports.js';
import { registerHealthcheckTools } from '../src/tools/health.js';
import {
  buildStudentDirectory,
  loadStudentDirectory,
  type StudentDirectory,
} from '../src/tools/student-directory.js';
import { jsonResponse, testConfig, tokenHandler } from './helpers.js';

/**
 * Context-group hints (`_meta.mint`, mcp-host spec 2026-11-03 D4), asserted
 * against the SERVED tool list — what a host reads — rather than a hand-kept
 * copy of the registrars' configs.
 */

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  mhlb_whoami: 'lookup',
  mhlb_session_reset: 'other',
  mhlb_list_students: 'lookup',
  mhlb_get_student_form: 'lookup',
  mhlb_new_student_form: 'lookup',
  mhlb_create_student: 'change',
  mhlb_update_student: 'change',
  mhlb_delete_student: 'change',
  mhlb_get_calendar: 'whats-on',
  mhlb_get_day: 'whats-on',
  mhlb_get_cart: 'lookup',
  mhlb_get_cart_tabs: 'lookup',
  mhlb_get_menu: 'lookup',
  mhlb_get_order_form: 'lookup',
  mhlb_get_order: 'lookup',
  mhlb_create_order: 'change',
  mhlb_update_order: 'change',
  mhlb_delete_order: 'change',
  mhlb_list_transactions: 'lookup',
  mhlb_get_transaction: 'lookup',
  mhlb_list_subscriptions: 'lookup',
  mhlb_get_subscription_settings: 'lookup',
  mhlb_set_subscription_enabled: 'turn-on-off',
  mhlb_unsubscribe_order: 'change',
  mhlb_list_gift_cards: 'lookup',
  mhlb_apply_gift_card: 'change',
  mhlb_get_coupon: 'lookup',
  mhlb_apply_coupon: 'change',
  mhlb_remove_coupon: 'change',
  mhlb_init_checkout: 'change',
  mhlb_checkout: 'change',
  mhlb_print_calendar: 'other',
  mhlb_print_orders: 'other',
  mhlb_print_transaction: 'other',
};

const STUDENTS = [
  { id: 101, firstName: 'Avery' },
  { id: 102, firstName: 'Blake' },
];

interface ListedTool {
  name: string;
  _meta?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, Record<string, unknown>>; required?: string[] };
}

function clientWith(apiBody: (url: string, init: RequestInit) => unknown) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const token = tokenHandler()(url);
    if (token) return token;
    return jsonResponse(apiBody(url, init));
  });
  return { client: new MhlbClient(testConfig(), fetchSpy as unknown as typeof fetch), fetchSpy };
}

async function harnessFor(client: MhlbClient, students: StudentDirectory | null) {
  return createTestHarness((server) => {
    registerAccountTools(server, client);
    registerStudentTools(server, client);
    registerCalendarTools(server, client, students);
    registerOrderTools(server, client);
    registerBillingTools(server, client);
    registerCheckoutTools(server, client);
    registerReportTools(server, client);
    registerHealthcheckTools(server, client);
  });
}

async function listed(students: StudentDirectory | null = null): Promise<ListedTool[]> {
  const { client } = clientWith(() => ({}));
  const h = await harnessFor(client, students);
  try {
    return (await h.client.listTools()).tools as unknown as ListedTool[];
  } finally {
    await h.close();
  }
}

const mintOf = (t: ListedTool) => t._meta?.mint as Record<string, unknown> | undefined;

describe('_meta.mint on tools/list', () => {
  it('every served tool except the healthcheck is in the table, so a new tool cannot skip the decision', async () => {
    const tools = await listed();
    const hinted = tools.filter((t) => mintOf(t)).map((t) => t.name).sort();
    expect(hinted).toEqual(Object.keys(EXPECTED_INTENT).sort());
    // The mcp-utils healthcheck joins no group: a tool with no hint is in the
    // host's `all` connector only (spec D4).
    expect(tools.filter((t) => !mintOf(t)).map((t) => t.name)).toEqual(['mhlb_healthcheck']);
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s declares domain school and intent %s', async (name, intent) => {
    const mint = mintOf((await listed()).find((t) => t.name === name)!);
    expect(mint?.domain).toBe('school');
    expect(mint?.intent).toBe(intent);
  });

  it('every hint is shaped per the host contract', async () => {
    for (const tool of await listed(buildStudentDirectory(STUDENTS))) {
      const mint = mintOf(tool);
      if (!mint) continue;
      const name = tool.name;
      const props = tool.inputSchema.properties ?? {};
      expect(Object.keys(mint).filter((k) => !KEYS.includes(k)), name).toEqual([]);
      expect(DOMAINS, name).toContain(mint.domain);
      expect(INTENTS, name).toContain(mint.intent);
      if ('canonical' in mint) {
        expect(mint.canonical, name).toBe(true);
        expect(tool.annotations?.readOnlyHint, name).toBe(true);
        expect(['whats-new', 'whats-due', 'whats-on'], name).toContain(mint.intent);
        expect(props, name).toHaveProperty('view');
        expect(props.view.enum, name).toContain('brief');
      }
      if ('subject' in mint) expect(props, name).toHaveProperty(mint.subject as string);
      if ('when' in mint) {
        const when = mint.when as Record<string, unknown>;
        expect(Object.keys(when).sort(), name).toEqual(['end', 'start']);
        expect(props, name).toHaveProperty(when.start as string);
        expect(props, name).toHaveProperty(when.end as string);
      }
      if ('aliases' in mint) {
        const aliases = mint.aliases as string[];
        expect(aliases.length, name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, name).toBeLessThanOrEqual(40);
          expect(a, name).toBe(a.toLowerCase());
        }
      }
    }
  });

  it('marks exactly one canonical read: the lunch calendar for whats-on', async () => {
    const canonical = (await listed())
      .filter((t) => mintOf(t)?.canonical === true)
      .map((t) => [t.name, mintOf(t)?.intent]);
    expect(canonical).toEqual([['mhlb_get_calendar', 'whats-on']]);
  });

  it('the calendar names its subject and range arguments', async () => {
    const cal = (await listed()).find((t) => t.name === 'mhlb_get_calendar')!;
    expect(mintOf(cal)).toEqual({
      domain: 'school',
      intent: 'whats-on',
      canonical: true,
      subject: 'student',
      when: { start: 'startDate', end: 'endDate' },
      aliases: ['lunch', 'lunches', 'school lunch', 'hot lunch', 'lunch calendar', 'lunch orders', 'cafeteria'],
    });
  });

  it('publishes the student labels as an enum when they were listed at start', async () => {
    const cal = (await listed(buildStudentDirectory(STUDENTS))).find((t) => t.name === 'mhlb_get_calendar')!;
    expect(cal.inputSchema.properties?.student.enum).toEqual(['Avery', 'Blake']);
  });

  it('publishes the student argument with no enum (never an empty one) when nothing was listed', async () => {
    const cal = (await listed(null)).find((t) => t.name === 'mhlb_get_calendar')!;
    expect(cal.inputSchema.properties?.student).toBeDefined();
    expect(cal.inputSchema.properties?.student).not.toHaveProperty('enum');
  });
});

describe('the student directory', () => {
  it('labels by first name, disambiguating a shared name with the id', () => {
    const dir = buildStudentDirectory([
      { id: 1, firstName: 'Sam' },
      { id: 2, firstName: 'sam' },
      { id: 3, firstName: 'Kit' },
    ])!;
    expect(dir.labels).toEqual(['Sam (1)', 'sam (2)', 'Kit']);
    expect(dir.resolve('kit')).toBe(3);
    expect(dir.resolve(' SAM (2) ')).toBe(2);
    expect(dir.labelFor(3)).toBe('Kit');
  });

  it('passes a raw numeric id through, so a student added after start is still reachable', () => {
    const dir = buildStudentDirectory(STUDENTS)!;
    expect(dir.resolve('999')).toBe(999);
    expect(dir.resolve('101')).toBe(101);
  });

  it('refuses an unknown name, naming the known labels', () => {
    expect(() => buildStudentDirectory(STUDENTS)!.resolve('Zed')).toThrow(/Avery, Blake/);
  });

  it('is null — so no enum is published — for no students or rows with no usable id', () => {
    expect(buildStudentDirectory([])).toBeNull();
    expect(buildStudentDirectory({ not: 'an array' })).toBeNull();
    expect(buildStudentDirectory([{ firstName: 'NoId' }, null])).toBeNull();
  });

  it('falls back to the id as the label when a row has no first name', () => {
    expect(buildStudentDirectory([{ id: 7, firstName: '  ' }])!.labels).toEqual(['7']);
  });

  it('loads once from /parent/childrenInfo', async () => {
    const { client, fetchSpy } = clientWith(() => STUDENTS);
    const dir = await loadStudentDirectory(client);
    expect(dir?.labels).toEqual(['Avery', 'Blake']);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).endsWith('/api/parent/childrenInfo'))).toBe(true);
  });

  it('answers null, never throws, when the listing fails', async () => {
    const failing = new MhlbClient(testConfig(), (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch);
    await expect(loadStudentDirectory(failing)).resolves.toBeNull();
  });

  it('answers null when the listing outlives its bound', async () => {
    const hanging = new MhlbClient(testConfig(), (() => new Promise<Response>(() => {})) as unknown as typeof fetch);
    await expect(loadStudentDirectory(hanging, 20)).resolves.toBeNull();
  });
});

describe('mhlb_get_calendar view: brief', () => {
  const EVENTS = {
    events: [
      { id: 1, studentId: 101, title: 'Pizza Day', start: '2026-09-14T00:00:00', className: ['event-paid'] },
      { id: 2, studentId: 102, title: 'Taco Tuesday', start: '2026-09-15', className: 'event-open' },
      { id: 3, studentId: 101, start: '2026-09-16', className: [] },
    ],
  };

  it('answers one line per item inside the untrusted-data envelope', async () => {
    const { client } = clientWith(() => EVENTS);
    const h = await harnessFor(client, buildStudentDirectory(STUDENTS));
    try {
      const res = await h.callTool('mhlb_get_calendar', { startDate: '2026-09-01', endDate: '2026-09-30', view: 'brief' });
      const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      expect(body.untrusted_content).toBe(true);
      expect(body.note).toMatch(/school and its lunch vendors/);
      expect(body.data).toEqual([
        'Avery: Pizza Day — 2026-09-14 — paid',
        'Blake: Taco Tuesday — 2026-09-15 — open',
        'Avery: lunch — 2026-09-16 — no status',
      ]);
    } finally {
      await h.close();
    }
  });

  it('narrows to one student by label, in brief and full alike', async () => {
    const { client } = clientWith(() => EVENTS);
    const h = await harnessFor(client, buildStudentDirectory(STUDENTS));
    try {
      const brief = JSON.parse(
        ((await h.callTool('mhlb_get_calendar', {
          startDate: '2026-09-01', endDate: '2026-09-30', view: 'brief', student: 'blake',
        })).content as Array<{ text: string }>)[0].text,
      );
      expect(brief.data).toEqual(['Blake: Taco Tuesday — 2026-09-15 — open']);
      const full = JSON.parse(
        ((await h.callTool('mhlb_get_calendar', {
          startDate: '2026-09-01', endDate: '2026-09-30', student: '101',
        })).content as Array<{ text: string }>)[0].text,
      );
      expect(full.data.events.map((e: { id: number }) => e.id)).toEqual([1, 3]);
    } finally {
      await h.close();
    }
  });

  it('answers "-- none" for an empty range', async () => {
    const { client } = clientWith(() => ({ events: [] }));
    const h = await harnessFor(client, null);
    try {
      const body = JSON.parse(
        ((await h.callTool('mhlb_get_calendar', { startDate: '2026-09-01', endDate: '2026-09-30', view: 'brief' }))
          .content as Array<{ text: string }>)[0].text,
      );
      expect(body.data).toEqual(['-- none']);
    } finally {
      await h.close();
    }
  });

  it('resolves names from a fresh listing when none was taken at start', async () => {
    const { client } = clientWith((url) => (url.includes('childrenInfo') ? STUDENTS : EVENTS));
    const h = await harnessFor(client, null);
    try {
      const body = JSON.parse(
        ((await h.callTool('mhlb_get_calendar', {
          startDate: '2026-09-01', endDate: '2026-09-30', view: 'brief', student: 'Avery',
        })).content as Array<{ text: string }>)[0].text,
      );
      expect(body.data).toEqual(['Avery: Pizza Day — 2026-09-14 — paid', 'Avery: lunch — 2026-09-16 — no status']);
    } finally {
      await h.close();
    }
  });

  it('keeps the full answer unchanged when no view or student is given', async () => {
    const { client } = clientWith(() => EVENTS);
    const h = await harnessFor(client, null);
    try {
      const body = JSON.parse(
        ((await h.callTool('mhlb_get_calendar', { startDate: '2026-09-01', endDate: '2026-09-30' }))
          .content as Array<{ text: string }>)[0].text,
      );
      expect(body.data).toEqual(EVENTS);
    } finally {
      await h.close();
    }
  });

  it('refuses an unknown student name, naming the listed ones, before calling the calendar', async () => {
    const { client, fetchSpy } = clientWith(() => EVENTS);
    const h = await harnessFor(client, buildStudentDirectory(STUDENTS));
    try {
      const res = await h.callTool('mhlb_get_calendar', { startDate: '2026-09-01', endDate: '2026-09-30', student: 'Zed' });
      expect(res.isError).toBe(true);
      expect((res.content as Array<{ text: string }>)[0].text).toMatch(/Avery, Blake/);
      expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('studentSchoolData'))).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('refuses a student name when the account lists no students', async () => {
    const { client } = clientWith((url) => (url.includes('childrenInfo') ? [] : EVENTS));
    const h = await harnessFor(client, null);
    try {
      const res = await h.callTool('mhlb_get_calendar', { startDate: '2026-09-01', endDate: '2026-09-30', student: 'Avery' });
      expect(res.isError).toBe(true);
      expect((res.content as Array<{ text: string }>)[0].text).toMatch(/lists no students/);
    } finally {
      await h.close();
    }
  });

  it('reports an answer with no events list as an error note, never as "-- none"', async () => {
    const { client } = clientWith((url) => (url.includes('childrenInfo') ? STUDENTS : { unexpected: true }));
    const h = await harnessFor(client, null);
    try {
      const body = JSON.parse(
        ((await h.callTool('mhlb_get_calendar', { startDate: '2026-09-01', endDate: '2026-09-30', view: 'brief' }))
          .content as Array<{ text: string }>)[0].text,
      );
      expect(body.data).toEqual(['-- error: the calendar answered without an events list']);
    } finally {
      await h.close();
    }
  });

  it('keeps every line within 120 characters, shortening the title', () => {
    const line = briefLine({ title: 'x'.repeat(300), start: '2026-09-14', className: ['event-paid'] }, 'Avery');
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.endsWith(' — 2026-09-14 — paid')).toBe(true);
    expect(line.startsWith('Avery: x')).toBe(true);
  });

  it('reads both class spellings the site uses as status words, ignoring styling classes', () => {
    expect(briefLine({ title: 'Lunch', start: '2026-09-14', className: ['past-event', 'event-paid', 'fc-x'] }))
      .toBe('Lunch — 2026-09-14 — past/paid');
    expect(briefLine({ title: 'Holiday', start: '2026-09-14', className: ['school-event'] }))
      .toBe('Holiday — 2026-09-14 — school event');
  });

  it('escapes a line whose text starts with "-- " so an item never reads as a note', () => {
    expect(briefLine({ title: '-- none', start: '2026-09-14', className: ['event-paid'] }))
      .toBe('\\-- none — 2026-09-14 — paid');
    expect(briefLine({ title: '-- 1 of 9 shown', start: '2026-09-14' }, '-- Avery'))
      .toBe('\\-- Avery: -- 1 of 9 shown — 2026-09-14 — no status');
  });

  it('escapes a line whose text starts with a backslash, since the host strips one from every item', () => {
    expect(briefLine({ title: '\\menu', start: '2026-09-14', className: ['event-paid'] }))
      .toBe('\\\\menu — 2026-09-14 — paid');
  });

  it('leaves a title that only contains "-- " later in the line alone', () => {
    expect(briefLine({ title: '-- none', start: '2026-09-14', className: ['event-paid'] }, 'Avery'))
      .toBe('Avery: -- none — 2026-09-14 — paid');
  });

  it('keeps an escaped line within 120 characters, the title cut first', () => {
    const line = briefLine({ title: '-- ' + 'x'.repeat(300), start: '2026-09-14', className: ['event-paid'] });
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.startsWith('\\-- x')).toBe(true);
    expect(line.endsWith('… — 2026-09-14 — paid')).toBe(true);
  });

  it('says "no date" for an event without a start', () => {
    expect(briefLine({ title: 'Field trip', className: ['event-closed'] })).toBe('Field trip — no date — closed');
  });
});
