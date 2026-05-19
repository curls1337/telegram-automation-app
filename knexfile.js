'use strict';

/**
 * Knex CLI configuration.
 *
 * Consumed by `knex migrate:*` and `knex seed:*` (see package.json scripts).
 * The connection string and pool sizing come from the same validated env
 * loader the runtime uses (`src/shared/env.js`), so migrations cannot be run
 * against a misconfigured environment.
 *
 * References:
 *   - requirements.md §21.2 (config via env), §21.4 (migration tooling).
 */

const { buildKnexConfig } = require('./src/infra/db');
const { getEnv } = require('./src/shared/env');

const env = getEnv();
const config = buildKnexConfig(env);

// The knex CLI looks up environments by `NODE_ENV`, falling back to
// `development`. We expose the same config under each known environment so
// the CLI works regardless of how it is invoked.
module.exports = {
  development: config,
  test: config,
  production: config,
};
