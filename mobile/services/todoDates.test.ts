/**
 * Self-check for the reminder arithmetic — which days get a notification and
 * what each one says.
 *
 * Run directly from .github/workflows/mobile-ci.yml, never as a package.json
 * script (mobile/AGENTS.md: the scripts block is hashed into the fingerprint).
 *
 * ⚠️ Imports ONLY the pure exports. `syncReminders` pulls in
 * expo-notifications, which cannot load outside a device.
 */
import assert from 'node:assert/strict';
import { digests, digestText, atTime, HORIZON_DAYS } from './todoDates.ts';

type T = { due_date: string | null; completed: boolean };
const todo = (due_date: string | null, completed = false): any => ({ due_date, completed });

const TODAY = '2026-09-24';

// ── which days deserve a reminder ───────────────────────────────────────────
const list: T[] = [
  todo('2026-09-22'),            // overdue
  todo('2026-09-23'),            // overdue
  todo(TODAY),                   // due today
  todo(TODAY),                   // due today
  todo('2026-09-25'),            // tomorrow
  todo('2026-10-30'),            // past the horizon
  todo(null),                    // "Someday" — deliberately unscheduled
  todo(TODAY, true),             // already done
  todo('2026-09-21', true),      // done, and was overdue
];

const d = digests(list as any, TODAY);
assert.deepEqual(d.map(x => x.date), [TODAY, '2026-09-25']);

// Completed tasks and "Someday" are not reminders. Someday means the user
// declined to schedule it; reminding them is overriding that.
assert.equal(d[0].due, 2);
assert.equal(d[0].overdue, 2);

// ⚠️ OVERDUE RIDES WITH TODAY ONLY. Attaching it to every day in the horizon
// would repeat the same nag for a week.
assert.equal(d[1].overdue, 0);
assert.equal(d[1].due, 1);

// A day past the horizon is not scheduled at all.
assert.ok(!d.some(x => x.date === '2026-10-30'));

// Nothing due anywhere = nothing scheduled, not an empty "you're all clear" ping.
assert.deepEqual(digests([todo(null), todo(TODAY, true)] as any, TODAY), []);

// A task overdue with nothing due today still earns today's slot.
const onlyOverdue = digests([todo('2026-09-01')] as any, TODAY);
assert.equal(onlyOverdue.length, 1);
assert.equal(onlyOverdue[0].due, 0);
assert.equal(onlyOverdue[0].overdue, 1);

// The horizon is inclusive of today, so the last day it can reach is +6.
const far = digests([todo('2026-09-30')] as any, TODAY);
assert.equal(far.length, 1);
assert.equal(HORIZON_DAYS, 7);

// ── wording ────────────────────────────────────────────────────────────────
assert.equal(digestText({ date: TODAY, due: 1, overdue: 0 }, true).title, '1 task due today');
assert.equal(digestText({ date: TODAY, due: 3, overdue: 0 }, true).title, '3 tasks due today');
assert.equal(digestText({ date: TODAY, due: 2, overdue: 0 }, false).title, '2 tasks due tomorrow');
assert.ok(digestText({ date: TODAY, due: 2, overdue: 1 }, true).body.includes('1 task still overdue'));
assert.equal(digestText({ date: TODAY, due: 0, overdue: 4 }, true).title, '4 tasks overdue');

// ── the clock ───────────────────────────────────────────────────────────────
const at = atTime('2026-09-24', '09:00');
assert.ok(at);
assert.equal(at!.getHours(), 9);
assert.equal(at!.getMinutes(), 0);
// ⚠️ Local, never UTC — `new Date("2026-09-24")` is UTC midnight and renders as
// the previous day west of Greenwich. parseLocal is what avoids that.
assert.equal(at!.getDate(), 24);

assert.equal(atTime('2026-09-24', '25:00'), null);
assert.equal(atTime('2026-09-24', '09:70'), null);
assert.equal(atTime('not-a-date', '09:00'), null);
assert.equal(atTime('2026-02-31', '09:00'), null);   // rolls over in Date, rejected here
assert.equal(atTime('2026-09-24', ''), null);

console.log('reminders: all assertions passed');
