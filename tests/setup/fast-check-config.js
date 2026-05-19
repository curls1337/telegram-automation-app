'use strict';

/**
 * Global fast-check configuration for property tests.
 *
 * Loaded by Jest (via the `property` project's `setupFiles`) before any
 * property test file is evaluated, so individual `fc.assert(...)` calls
 * inherit these defaults without each test having to repeat them.
 *
 * Tunable via environment variables:
 *   - FC_NUM_RUNS  override the default number of runs per property
 *                  (defaults to 100, matching the design strategy).
 *   - FC_SEED      pin the PRNG seed for reproducibility (e.g. when
 *                  re-running a failing CI job). When unset, a fresh
 *                  Date.now() seed is used so each run explores new inputs.
 *   - FC_VERBOSE   set to '0' / 'false' to disable verbose counter-example
 *                  output. Defaults to verbose=true per design.
 */

const fc = require('fast-check');

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseSeed(value) {
  if (value === undefined || value === null || value === '') {
    return Date.now();
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return Date.now();
  }
  return parsed;
}

function parseVerbose(value) {
  if (value === undefined || value === null || value === '') {
    return true;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return true;
}

const numRuns = parsePositiveInt(process.env.FC_NUM_RUNS, 100);
const seed = parseSeed(process.env.FC_SEED);
const verbose = parseVerbose(process.env.FC_VERBOSE);

fc.configureGlobal({
  numRuns,
  seed,
  verbose,
});

// Surface the effective seed so failing CI runs can be reproduced by setting
// FC_SEED to the value printed below. Stays silent in non-TTY CI logs unless
// explicitly opted out.
if (process.env.FC_SEED === undefined) {
  // eslint-disable-next-line no-console
  console.info(`[fast-check] using seed=${seed} numRuns=${numRuns} (set FC_SEED to reproduce)`);
}

module.exports = {
  numRuns,
  seed,
  verbose,
};
