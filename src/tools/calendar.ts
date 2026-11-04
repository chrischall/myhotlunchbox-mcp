import { McpToolError, toolAnnotations, PositiveInt, IsoDate } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MhlbClient } from '../client.js';
import { UNTRUSTED, schoolMeta, untrustedRead } from './_shared.js';
import { buildStudentDirectory, type StudentDirectory } from './student-directory.js';

const BRIEF_MAX = 120;

const STUDENT_DESCRIPTION =
  'Limit to one student: their first name as listed, or their student id from mhlb_list_students. ' +
  'Omit for every student on the account.';

/**
 * `student` publishes the student LABELS as a JSON Schema `enum` when the
 * server could list them at start (mcp-host spec D5), via `.meta()` — so the
 * runtime schema is still any string and the handler accepts a label or an id.
 * With no listing the property is published plain: an empty `enum` is invalid
 * JSON Schema.
 */
function studentArg(students: StudentDirectory | null | undefined) {
  const base = z.string();
  return (students ? base.meta({ enum: students.labels }) : base).optional().describe(STUDENT_DESCRIPTION);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * The calendar's status classes, read as words. The site's FullCalendar
 * `className` carries both spellings — `event-paid`, `event-scheduled`,
 * `event-subscribed` and `past-event`, `school-event` (seen live) — so both
 * `event-<word>` and `<word>-event` read as `<word>`; any other class is
 * styling, not status, and is ignored.
 */
function statusOf(className: unknown): string {
  const classes = Array.isArray(className) ? className : typeof className === 'string' ? className.split(/\s+/) : [];
  const words = classes
    .filter((c): c is string => typeof c === 'string')
    .map((c) => /^event-(.+)$/.exec(c)?.[1] ?? /^(.+)-event$/.exec(c)?.[1])
    .filter((w): w is string => w !== undefined)
    // `school-event` marks a school calendar entry, not a lunch's state.
    .map((w) => (w === 'school' ? 'school event' : w));
  return words.length > 0 ? words.join('/') : 'no status';
}

/**
 * One calendar event as one line, `<student>: title — <ISO date | no date> —
 * <status>`, at most 120 characters (the title is shortened). Read only from
 * the fields the calendar's events carry: `title`, `start`, `className`.
 */
export function briefLine(event: unknown, studentLabel?: string): string {
  const e = (event && typeof event === 'object' ? event : {}) as Record<string, unknown>;
  const title = str(e.title) ?? 'lunch';
  const start = str(e.start);
  const date = start && /^\d{4}-\d{2}-\d{2}/.test(start) ? start.slice(0, 10) : 'no date';
  const prefix = studentLabel ? `${studentLabel}: ` : '';
  const tail = ` — ${date} — ${statusOf(e.className)}`;
  const room = BRIEF_MAX - tail.length - prefix.length;
  const shown = title.length > room ? `${title.slice(0, Math.max(room - 1, 0))}…` : title;
  return `${prefix}${shown}${tail}`.slice(0, BRIEF_MAX);
}

function eventsOf(data: unknown): unknown[] | null {
  if (!data || typeof data !== 'object') return null;
  const events = (data as Record<string, unknown>).events;
  return Array.isArray(events) ? events : null;
}

export function registerCalendarTools(
  server: McpServer,
  client: MhlbClient,
  students?: StudentDirectory | null,
): void {
  // Names a call can resolve: the start-time listing, else a fresh one (a
  // student added since, or a listing that missed its bound at start).
  const directory = async (): Promise<StudentDirectory | null> =>
    students ?? buildStudentDirectory(await client.get<unknown>('/parent/childrenInfo'));

  const argsSchema = z.object({
    startDate: IsoDate.describe('First day to include (YYYY-MM-DD).'),
    endDate: IsoDate.describe('Last day to include (YYYY-MM-DD).'),
    student: studentArg(students),
    view: z.enum(['full', 'brief']).optional().describe(
      '"full" (default) returns the calendar verbatim; "brief" returns one line per lunch event: ' +
      '<student>: title — <ISO date or "no date"> — <status, e.g. paid, scheduled, subscribed, past, school event>.',
    ),
  });

  server.registerTool(
    'mhlb_get_calendar',
    {
      description:
        'Get the lunch calendar for the account over a date range: which days are open for ordering, already ' +
        'ordered, paid, in the cart, subscribed or closed, per student. This is what the Lunch Calendar page shows. ' +
        'Pass student to narrow to one child.' + UNTRUSTED,
      annotations: toolAnnotations({ title: 'Get lunch calendar', openWorld: true }),
      _meta: schoolMeta('whats-on', {
        canonical: true,
        subject: 'student',
        when: { start: 'startDate', end: 'endDate' },
        aliases: ['lunch', 'lunches', 'school lunch', 'hot lunch', 'lunch calendar', 'lunch orders', 'cafeteria'],
      }),
      inputSchema: argsSchema,
    },
    // Field names are `start`/`end`, captured from the live app. Sending
    // `startDate`/`endDate` returns 200 with an empty `events` array — a silent
    // wrong answer, not an error.
    async ({ startDate, endDate, student, view }) => {
      let dir: StudentDirectory | null = students ?? null;
      let studentId: number | undefined;
      if (student !== undefined) {
        const ref = student.trim();
        if (/^\d+$/.test(ref)) {
          studentId = Number(ref);
        } else {
          dir = await directory();
          if (!dir) {
            throw new McpToolError(`Unknown student "${student}": the account lists no students.`, {
              hint: 'Call mhlb_list_students and pass a student id.',
            });
          }
          try {
            studentId = dir.resolve(ref);
          } catch (cause) {
            throw new McpToolError((cause as Error).message, { hint: 'Pass a listed first name or a student id.' });
          }
        }
      }

      const data = await client.write<unknown>('/calendar/studentSchoolData', { start: startDate, end: endDate });
      const all = eventsOf(data);
      const events =
        all && studentId !== undefined
          ? all.filter((e) => Number((e as Record<string, unknown> | null)?.studentId) === studentId)
          : all;

      if (view === 'brief') {
        // Names for the line prefix; a failed listing costs the prefix, never the answer.
        if (!dir) dir = await directory().catch(() => null);
        if (events === null) {
          return untrustedRead(['-- error: the calendar answered without an events list']);
        }
        const lines = events.map((e) =>
          briefLine(e, dir?.labelFor((e as Record<string, unknown> | null)?.studentId)),
        );
        return untrustedRead(lines.length > 0 ? lines : ['-- none']);
      }
      return untrustedRead(events && events !== all ? { ...(data as Record<string, unknown>), events } : data);
    },
  );

  server.registerTool(
    'mhlb_get_day',
    {
      description:
        'Get what a student has ordered on one specific date — the items, sizes, quantities, add-ons and prices.' + UNTRUSTED,
      annotations: toolAnnotations({ title: 'Get a day’s order', openWorld: true }),
      _meta: schoolMeta('whats-on', { aliases: ['lunch today', "what's for lunch", 'lunch order'] }),
      inputSchema: z.object({
        studentId: PositiveInt.describe('Student id from mhlb_list_students.'),
        date: IsoDate.describe('The day to look at (YYYY-MM-DD).'),
      }),
    },
    async ({ studentId, date }) =>
      untrustedRead(await client.get('/calendar/studentOrderItems', { studentId, date })),
  );
}
