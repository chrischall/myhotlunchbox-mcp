import type { MhlbClient } from '../client.js';

/**
 * The account's students, as labels a person can name a child by (mcp-host
 * spec 2026-11-03 D5: a subject is an enum of LABELS, accepting label or id).
 * The label is the student's first name — what the site itself shows.
 */
export interface StudentDirectory {
  /** One label per student, in the site's order; never empty. */
  labels: string[];
  /**
   * A label (any case, trimmed) → that student's id. A raw numeric id passes
   * through unchanged, so a student added after start is still reachable.
   * Anything else is refused, naming the labels.
   */
  resolve(value: string): number;
  /** The label for a student id, when it is one this directory holds. */
  labelFor(id: unknown): string | undefined;
}

/** Bound on the start-time listing: a host must not wait on it to list tools. */
export const STUDENT_LIST_TIMEOUT_MS = 5_000;

const RAW_ID = /^\d+$/;

/**
 * Build the directory from a `/parent/childrenInfo` answer. Null — so the
 * `student` argument is published with no `enum`, never an empty one — when
 * there are no rows with a usable id.
 */
export function buildStudentDirectory(rows: unknown): StudentDirectory | null {
  if (!Array.isArray(rows)) return null;
  const users: Array<{ id: number; label: string }> = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === 'number' ? r.id : typeof r.id === 'string' && RAW_ID.test(r.id) ? Number(r.id) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const name = typeof r.firstName === 'string' && r.firstName.trim() !== '' ? r.firstName.trim() : String(id);
    users.push({ id, label: name });
  }
  if (users.length === 0) return null;

  // Two students sharing a first name would make the name ambiguous, so each
  // carries its id; the label stays resolvable and never picks the wrong child.
  const counts = new Map<string, number>();
  for (const u of users) counts.set(u.label.toLowerCase(), (counts.get(u.label.toLowerCase()) ?? 0) + 1);
  const labelled = users.map((u) => ({
    id: u.id,
    label: counts.get(u.label.toLowerCase())! > 1 ? `${u.label} (${u.id})` : u.label,
  }));
  const byLabel = new Map(labelled.map((u) => [u.label.toLowerCase(), u.id]));
  const byId = new Map(labelled.map((u) => [u.id, u.label]));
  const labels = labelled.map((u) => u.label);
  return {
    labels,
    resolve(value: string): number {
      const ref = value.trim();
      const id = byLabel.get(ref.toLowerCase());
      if (id !== undefined) return id;
      if (RAW_ID.test(ref)) return Number(ref);
      throw new Error(`Unknown student "${value}". Known: ${labels.join(', ')}.`);
    },
    labelFor(id: unknown): string | undefined {
      const n = typeof id === 'number' ? id : typeof id === 'string' && RAW_ID.test(id) ? Number(id) : NaN;
      return byId.get(n);
    },
  };
}

/**
 * List the students ONCE, at server start, for the calendar's `student` enum.
 * Answers null when the account has no students, when the listing fails (no
 * credentials, a rejected sign-in — which the client latches, so nothing is
 * retried), or when it has not answered within `timeoutMs`. Never throws.
 */
export async function loadStudentDirectory(
  client: MhlbClient,
  timeoutMs: number = STUDENT_LIST_TIMEOUT_MS,
): Promise<StudentDirectory | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref();
  });
  const listing = client
    .get<unknown>('/parent/childrenInfo')
    .then(buildStudentDirectory)
    .catch(() => null);
  try {
    return await Promise.race([listing, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
