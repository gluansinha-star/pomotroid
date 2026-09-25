/**
 * Seed the app's SQLite database with realistic session history so the stats
 * windows have something to show during review.
 *
 * This is a DEVELOPMENT helper — it writes directly to the app's data directory
 * and CLEARS existing session rows.
 *
 * Usage:
 *   node scripts/seed-demo-data.mjs            # ~5 months of history
 *   node scripts/seed-demo-data.mjs --clear    # wipe sessions only
 *
 * The app must not be running when this executes.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CLEAR_ONLY = process.argv.includes('--clear');

const appDataDir = process.env.APPDATA
  ? join(process.env.APPDATA, 'com.splode.pomotroid')
  : join(process.env.HOME ?? '.', '.local', 'share', 'com.splode.pomotroid');

mkdirSync(appDataDir, { recursive: true });
const dbPath = join(appDataDir, 'pomotroid.db');

console.log(`Database: ${dbPath}`);
if (!existsSync(dbPath)) {
  console.log('(file does not exist yet — it will be created)');
}

const db = new DatabaseSync(dbPath);

// --- Schema: mirrors src-tauri/src/db/migrations.rs -------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    round_type    TEXT NOT NULL CHECK(round_type IN ('work', 'short-break', 'long-break')),
    duration_secs INTEGER NOT NULL CHECK(duration_secs > 0),
    completed     INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS custom_themes (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT NOT NULL UNIQUE,
    colors TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_round_type ON sessions(round_type);
`);

const version = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v;
if (version === 0) {
  db.exec('INSERT INTO schema_version VALUES (1)');
}
// Keep the recorded version current so migrations do not re-run.
const maxVersion = 7;
if (version < maxVersion) {
  db.exec(`DELETE FROM schema_version`);
  db.exec(`INSERT INTO schema_version VALUES (${maxVersion})`);
}

const deleted = db.prepare('DELETE FROM sessions').run();
console.log(`Cleared ${deleted.changes} existing session row(s).`);

if (CLEAR_ONLY) {
  db.close();
  console.log('Done (clear only).');
  process.exit(0);
}

// --- Deterministic pseudo-random -------------------------------------------
function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

// --- Generate sessions ------------------------------------------------------

/** Local midnight for a Date. */
function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

const now = new Date();
const todayStart = startOfLocalDay(now);

// Focus-hour targets are drawn from this weighted pool, biased towards the
// higher end: a typical day lands around 6–9 focused hours.
const HOUR_POOL = [
  2, 2.5, 3, 3.5, 4, 4, 4.5, 5, 5, 5.5, 6, 6, 6.5, 6.5, 7, 7, 7.5, 7.5, 8, 8, 8.5, 9, 9, 9.5, 10,
];

/** Earliest start hour for a day, varying by weekday (0 = Monday). */
const WEEKDAY_START_HOUR = [7, 7, 8, 8, 9, 9, 10];

/**
 * Describe one day's activity.
 *
 * A day is either a rest day (0 focus) or a working day whose total focus time
 * is drawn from `HOUR_POOL` (so 2–10 h, biased high). Recently recorded days
 * skew a little stronger, which makes the momentum and trend views interesting.
 *
 * Returns `null` for a rest day.
 */
function planDay(dayOffset) {
  const date = new Date(todayStart);
  date.setDate(date.getDate() - dayOffset);
  const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  const r = hash01(key);
  const weekday = (date.getDay() + 6) % 7; // 0 = Monday

  // Rest days: fewer of them in the last couple of weeks.
  const restChance = dayOffset < 14 ? 0.08 : dayOffset < 45 ? 0.14 : 0.2;
  if (r < restChance) return null;

  // Pick a focus-hour target, then nudge recent days upward.
  let hours = HOUR_POOL[Math.floor(hash01(`h${key}`) * HOUR_POOL.length)];
  if (dayOffset < 21) hours = Math.min(10, hours + 1);
  if (dayOffset < 7) hours = Math.min(10, hours + 1);

  // Earlier days rarely reach the very top of the range.
  if (dayOffset > 90) hours = Math.min(hours, 8);

  return {
    hours,
    startHour: WEEKDAY_START_HOUR[weekday],
    strength: hours >= 7 ? 'strong' : hours <= 3.5 ? 'light' : 'normal',
  };
}

/** Weighted pick of a round length (minutes) for a mixed-length day. */
const LENGTH_POOL = [5, 5, 10, 10, 15, 15, 20, 20, 25, 25, 30, 30, 30, 45];
function roundLengthMins(offset, index) {
  return LENGTH_POOL[Math.floor(hash01(`L${offset}-${index}`) * LENGTH_POOL.length)];
}

const insert = db.prepare(
  `INSERT INTO sessions (started_at, ended_at, round_type, duration_secs, completed)
   VALUES (?, ?, ?, ?, ?)`
);

const unixSecs = (d) => Math.floor(d.getTime() / 1000);

let inserted = 0;
let skippedCount = 0;
let totalFocusSecs = 0;

const DAYS = 200;
// Insert oldest → newest so ids follow chronological order.
for (let offset = DAYS; offset >= 0; offset -= 1) {
  const plan = planDay(offset);
  if (plan === null) continue;

  const day = new Date(todayStart);
  day.setDate(day.getDate() - offset);

  // Target focus time for the day, in whole minutes.
  const targetMins = Math.round(plan.hours * 60);

  // Two or three focus blocks per day, separated by real gaps.
  const blockCount = 2 + Math.floor(hash01(`b${offset}`) * 2); // 2–3 blocks
  // Gaps between blocks, in minutes.
  const gaps = Array.from({ length: blockCount - 1 }, () =>
    25 + Math.floor(hash01(`gap${offset}${Math.random()}`) * 55)
  );

  // Split the target across blocks (roughly even, with some variation).
  const weights = Array.from({ length: blockCount }, (_, i) => 0.75 + hash01(`w${offset}${i}`) * 0.5);
  const weightSum = weights.reduce((s, w) => s + w, 0);

  let cursorHour = plan.startHour;
  let cursorMin = Math.floor(hash01(`m${offset}`) * 35);
  let roundIndex = 0;
  let wroteMins = 0;

  for (let block = 0; block < blockCount; block += 1) {
    const blockTarget = Math.round((targetMins * weights[block]) / weightSum);
    let blockMins = 0;
    let blockRounds = 0;

    // Fill the block with rounds until its share of the target is reached.
    while (blockMins < blockTarget && blockRounds < 14) {
      const lengthMins = roundLengthMins(offset, roundIndex);
      const workStart = new Date(day);
      workStart.setHours(cursorHour, cursorMin, 0, 0);
      // Never place a session in the future.
      if (workStart.getTime() > now.getTime()) break;

      // ~1 in 10 rounds is abandoned part-way (started, not completed).
      const abandoned = hash01(`a${offset}-${roundIndex}`) < 0.1;
      // An abandoned round is cut short, so it contributes less real focus.
      const actualMins = abandoned ? Math.max(1, Math.round(lengthMins * 0.4)) : lengthMins;
      const workEnd = new Date(workStart.getTime() + actualMins * 60 * 1000);

      insert.run(
        unixSecs(workStart),
        unixSecs(workEnd),
        'work',
        lengthMins * 60,
        abandoned ? 0 : 1
      );
      inserted += 1;
      if (abandoned) {
        skippedCount += 1;
      } else {
        totalFocusSecs += lengthMins * 60;
      }
      wroteMins += actualMins;

      // Log the matching break so the timeline stays realistic. Long breaks are
      // earned every fourth completed round, mirroring the app's cycle.
      const isLongBreak = !abandoned && (blockRounds + 1) % 4 === 0;
      const breakMins = isLongBreak ? 15 : 5;
      const breakStart = new Date(workEnd.getTime() + 60 * 1000);
      insert.run(
        unixSecs(breakStart),
        unixSecs(new Date(breakStart.getTime() + breakMins * 60 * 1000)),
        isLongBreak ? 'long-break' : 'short-break',
        breakMins * 60,
        1
      );

      // Advance the clock: the round, its break, plus a little slack.
      cursorMin += actualMins + breakMins + Math.floor(hash01(`s${offset}${roundIndex}`) * 4);
      while (cursorMin >= 60) {
        cursorMin -= 60;
        cursorHour += 1;
      }

      blockMins += actualMins;
      blockRounds += 1;
      roundIndex += 1;
    }

    // Bail out of the day if we have run into the evening.
    if (cursorHour >= 22) break;

    // Insert the gap before the next block, if there is one.
    if (block < blockCount - 1) {
      cursorMin += gaps[block] ?? 40;
      while (cursorMin >= 60) {
        cursorMin -= 60;
        cursorHour += 1;
      }
      if (cursorHour >= 22) break;
    }
  }
}

// Guarantee a live "today" so the Today panels and streak are populated.
// The main loop can write little or nothing for today when the generated
// schedule runs past the current clock time, so top it up here.
{
  const todayMins = db
    .prepare(
      `SELECT COALESCE(SUM(duration_secs), 0) / 60 AS mins FROM sessions
       WHERE round_type = 'work' AND completed = 1
         AND date(started_at, 'unixepoch', 'localtime') = date('now', 'localtime')`
    )
    .get().mins;

  // Target at least ~2.5 focused hours today (never more than the clock allows).
  const targetMins = 150;
  if (todayMins < targetMins) {
    let cursor = new Date(todayStart);
    cursor.setHours(8, 30, 0, 0);
    const lengths = [25, 25, 30, 20, 30, 25, 15, 30];
    let i = 0;

    while (cursor.getTime() + 25 * 60 * 1000 < now.getTime() && i < lengths.length) {
      const mins = lengths[i];
      const end = new Date(cursor.getTime() + mins * 60 * 1000);
      if (end.getTime() > now.getTime()) break;
      insert.run(unixSecs(cursor), unixSecs(end), 'work', mins * 60, 1);
      inserted += 1;
      totalFocusSecs += mins * 60;
      // Work round + a 5 minute break before the next one.
      cursor = new Date(end.getTime() + 5 * 60 * 1000);
      i += 1;
    }
  }
}

// Also make sure yesterday has sessions, so the streak reads as alive.
{
  const existingYesterday = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions
       WHERE round_type = 'work'
         AND date(started_at, 'unixepoch', 'localtime') = date('now', 'localtime', '-1 day')`
    )
    .get().n;

  if (existingYesterday === 0) {
    const day = new Date(todayStart);
    day.setDate(day.getDate() - 1);
    for (let i = 0; i < 6; i += 1) {
      const start = new Date(day);
      start.setHours(9 + i, 10 + (i % 3) * 7, 0, 0);
      const dur = (20 + i * 5) * 60;
      insert.run(unixSecs(start), unixSecs(new Date(start.getTime() + dur * 1000)), 'work', dur, 1);
      inserted += 1;
      totalFocusSecs += dur;
    }
  }
}

// --- Report -----------------------------------------------------------------
const summary = db
  .prepare(
    `SELECT COUNT(*) AS total,
            SUM(completed) AS completed,
            COUNT(DISTINCT date(started_at, 'unixepoch', 'localtime')) AS days,
            MIN(date(started_at, 'unixepoch', 'localtime')) AS first,
            MAX(date(started_at, 'unixepoch', 'localtime')) AS last
     FROM sessions WHERE round_type = 'work'`
  )
  .get();

console.log('');
console.log(`Inserted        : ${inserted} session row(s) (${skippedCount} abandoned)`);
console.log(`Focus time      : ${Math.round(totalFocusSecs / 3600)}h ${Math.round((totalFocusSecs % 3600) / 60)}m`);
console.log(`Work rounds     : ${summary.completed} completed / ${summary.total} started`);
console.log(`Active days     : ${summary.days}`);
console.log(`Date range      : ${summary.first} → ${summary.last}`);

db.close();
console.log('\nDone. Launch the app to review the stats.');
