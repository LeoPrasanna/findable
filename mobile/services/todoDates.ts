import type { Todo } from './api';
/**
 * Calendar-date helpers for the to-do list.
 *
 * Every date here is a plain "YYYY-MM-DD" in the DEVICE's timezone. The server
 * stores exactly that string and never converts it, so all bucketing lives on
 * the client — "today" is a local concept and the backend runs on UTC.
 *
 * ⚠️ Never use `new Date("2026-08-01")` on these: the ISO-date form is parsed as
 * UTC midnight, which renders as the PREVIOUS day everywhere west of Greenwich.
 * `parseLocal` builds the date from parts instead, which is always local.
 */

export type Bucket = 'overdue' | 'today' | 'upcoming' | 'someday';

/** "YYYY-MM-DD" -> local Date at midnight. Returns null for junk. */
export function parseLocal(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  // Rejects overflow like 2026-02-31, which the Date constructor would roll over.
  return dt.getMonth() === mo - 1 && dt.getDate() === d ? dt : null;
}

/** Local Date -> "YYYY-MM-DD" (never `toISOString()`, which shifts to UTC). */
export function toISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function todayISO(): string {
  return toISODate(new Date());
}

/** Today + n days, as a local calendar date string. */
export function daysFromToday(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/** The coming Saturday (today counts if it already is Saturday). */
export function nextWeekend(): string {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
  return toISODate(d);
}

/** Whole days from today — negative means overdue. */
export function daysUntil(iso: string): number | null {
  const target = parseLocal(iso);
  if (!target) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

export function bucketOf(due: string | null): Bucket {
  if (!due) return 'someday';
  const n = daysUntil(due);
  if (n === null) return 'someday';
  if (n < 0) return 'overdue';
  if (n === 0) return 'today';
  return 'upcoming';
}

/** Short human label for a due date: "Today", "Tomorrow", "3 days late", "Mon 4 Aug". */
export function formatDue(due: string | null): string {
  if (!due) return 'Someday';
  const n = daysUntil(due);
  const d = parseLocal(due);
  if (n === null || !d) return 'Someday';
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return '1 day late';
  if (n < 0) return `${-n} days late`;
  if (n < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/* ── Reminders ──────────────────────────────────────────────────────────────
   WHICH days get a reminder and WHAT each one says.

   ⚠️ IT LIVES HERE RATHER THAN IN services/reminders.ts FOR ONE REASON: that
   file imports expo-notifications and react-native, and a test that pulls those
   in cannot run outside a device. This file imports nothing at runtime (the
   Todo import above is type-only and is erased), so CI can check the part most
   likely to be wrong — the day arithmetic and the plurals — with plain node.
   Same split, and the same reason, as notifyLog.ts vs notifyStore.ts.
   ────────────────────────────────────────────────────────────────────────── */

/** How far ahead to schedule. A week covers a normal gap between app opens. */
export const HORIZON_DAYS = 7;

/** Every reminder we schedule carries this prefix, so we can cancel ours and
 *  leave anything else (the share pop) alone. */
const ID_PREFIX = 'findable-due-';

export interface DayDigest {
  /** Local calendar date, "YYYY-MM-DD". */
  date: string;
  /** Tasks due ON that date. */
  due: number;
  /** Tasks already overdue as of today — only ever attached to the FIRST day. */
  overdue: number;
}

/**
 * Which days in the horizon deserve a reminder, and what each one is about.
 *
 * Pure so the arithmetic can be checked without a device — see reminders.test.ts.
 * Completed tasks and tasks with no due date ("Someday") are not reminders:
 * "Someday" means the user deliberately declined to schedule it.
 */
export function digests(todos: Todo[], today: string, horizon = HORIZON_DAYS): DayDigest[] {
  const open = todos.filter(t => !t.completed && t.due_date);
  const overdue = open.filter(t => (t.due_date as string) < today).length;

  const start = parseLocal(today);
  if (!start) return [];

  const out: DayDigest[] = [];
  for (let i = 0; i < horizon; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const iso = toISODate(d);
    const due = open.filter(t => t.due_date === iso).length;
    // Overdue rides along with TODAY only. Attaching it to every day would
    // repeat the same nag for a week.
    const carry = i === 0 ? overdue : 0;
    if (due > 0 || carry > 0) out.push({ date: iso, due, overdue: carry });
  }
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function digestText(d: DayDigest, isToday: boolean): { title: string; body: string } {
  const when = isToday ? 'today' : 'tomorrow';
  if (d.due === 0) {
    // Overdue only — the day itself has nothing on it.
    return {
      title: `${plural(d.overdue, 'task')} overdue`,
      body: 'Still waiting on your slate. Tap to pick them up.',
    };
  }
  const title = `${plural(d.due, 'task')} due ${when}`;
  const body = d.overdue > 0
    ? `And ${plural(d.overdue, 'task')} still overdue. Tap to open your slate.`
    : 'Tap to open your slate.';
  return { title, body };
}

/** Local Date for "this calendar date at HH:MM". */
export function atTime(dateISO: string, time: string): Date | null {
  const d = parseLocal(dateISO);
  const m = /^(\d{1,2}):(\d{2})$/.exec(time || '');
  if (!d || !m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  d.setHours(h, min, 0, 0);
  return d;
}
