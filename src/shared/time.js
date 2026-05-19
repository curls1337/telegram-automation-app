'use strict';

/**
 * Time / date helpers for the Telegram Automation App.
 *
 * Every module that schedules work (drip campaigns, broadcasts, scheduled
 * posts, reset-token expiry, ...) needs a small, predictable surface for
 * "now" and "now + N seconds". Centralizing those primitives here keeps the
 * codebase consistent and makes it trivial to swap in a fake clock during
 * tests if we ever need to.
 *
 * Design references:
 *  - design.md → "Shared utilities" lists `src/shared/time.js`.
 *  - design.md → "Scheduling" relies on offset arithmetic for drip steps
 *    (`addDays`, `addHours`, `addMinutes`) and expiry checks (`isExpired`).
 *
 * Conventions:
 *  - All functions return *new* `Date` instances; inputs are never mutated.
 *  - ISO output uses `Date.prototype.toISOString()` (always UTC, with `Z`).
 *  - `parseIso(s)` is strict — it throws on invalid input rather than
 *    returning `Invalid Date` so callers do not silently propagate NaN.
 */

// ---------------------------------------------------------------------------
// "Now"
// ---------------------------------------------------------------------------

/**
 * Current wall-clock time as a `Date`. Wrapping `new Date()` lets tests
 * monkey-patch this single export when fine-grained control is needed.
 *
 * @returns {Date}
 */
function now() {
  return new Date();
}

/**
 * Current wall-clock time as an ISO-8601 string in UTC (`...Z`).
 *
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Offsets
// ---------------------------------------------------------------------------

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Internal helper: validate the inputs and return a fresh shifted `Date`.
 * Throws on non-Date / non-finite-number inputs so bugs surface early.
 *
 * @param {Date} date
 * @param {number} amount
 * @param {number} msPerUnit
 * @param {string} fnName
 * @returns {Date}
 */
function shift(date, amount, msPerUnit, fnName) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError(`${fnName}(date, n): date must be a valid Date`);
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new TypeError(`${fnName}(date, n): n must be a finite number`);
  }
  return new Date(date.getTime() + amount * msPerUnit);
}

/**
 * Return a new `Date` shifted by `seconds` seconds (may be negative).
 *
 * @param {Date} date
 * @param {number} seconds
 * @returns {Date}
 */
function addSeconds(date, seconds) {
  return shift(date, seconds, MS_PER_SECOND, 'addSeconds');
}

/**
 * Return a new `Date` shifted by `minutes` minutes (may be negative).
 *
 * @param {Date} date
 * @param {number} minutes
 * @returns {Date}
 */
function addMinutes(date, minutes) {
  return shift(date, minutes, MS_PER_MINUTE, 'addMinutes');
}

/**
 * Return a new `Date` shifted by `hours` hours (may be negative).
 *
 * @param {Date} date
 * @param {number} hours
 * @returns {Date}
 */
function addHours(date, hours) {
  return shift(date, hours, MS_PER_HOUR, 'addHours');
}

/**
 * Return a new `Date` shifted by `days` days (may be negative). Note that
 * this performs naive 24h arithmetic and does NOT account for DST — that is
 * fine for queue scheduling, but callers that need calendar-day semantics
 * should use a proper timezone library.
 *
 * @param {Date} date
 * @param {number} days
 * @returns {Date}
 */
function addDays(date, days) {
  return shift(date, days, MS_PER_DAY, 'addDays');
}

// ---------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------

/**
 * Return `a - b` in milliseconds.
 *
 * @param {Date} a
 * @param {Date} b
 * @returns {number}
 */
function differenceMs(a, b) {
  if (!(a instanceof Date) || Number.isNaN(a.getTime())) {
    throw new TypeError('differenceMs(a, b): a must be a valid Date');
  }
  if (!(b instanceof Date) || Number.isNaN(b.getTime())) {
    throw new TypeError('differenceMs(a, b): b must be a valid Date');
  }
  return a.getTime() - b.getTime();
}

/**
 * `true` when `date` is strictly in the past relative to `now()`.
 * Treats invalid dates as expired so callers do not accidentally treat
 * malformed timestamps as "still valid".
 *
 * @param {Date} date
 * @returns {boolean}
 */
function isExpired(date) {
  if (!(date instanceof Date)) return true;
  const t = date.getTime();
  if (Number.isNaN(t)) return true;
  return t < Date.now();
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse an ISO-8601 date-time string into a `Date`. Throws a `TypeError`
 * when the input is not a string or not parseable, so callers never have to
 * check for `Invalid Date` themselves.
 *
 * @param {string} s
 * @returns {Date}
 */
function parseIso(s) {
  if (typeof s !== 'string' || s.length === 0) {
    throw new TypeError('parseIso(s): s must be a non-empty ISO-8601 string');
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new TypeError(`parseIso(s): invalid ISO-8601 string: ${s}`);
  }
  return d;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  now,
  nowIso,
  addSeconds,
  addMinutes,
  addHours,
  addDays,
  differenceMs,
  isExpired,
  parseIso,
};
