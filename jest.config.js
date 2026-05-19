'use strict';

/**
 * Jest configuration for telegram-automation-app.
 *
 * Three projects are defined so that running `jest` executes all suites,
 * while `jest --selectProjects unit|property|integration` (also exposed via
 * the `npm run test:property` and `npm run test:integration` scripts) runs a
 * single tier in isolation.
 *
 * Property tests use fast-check; configuration (numRuns, FC_SEED) lives in
 * `tests/setup/fast-check-config.js` so it can be loaded once per worker
 * before any property test runs.
 */
module.exports = {
  // Root config defaults; individual projects can override.
  testEnvironment: 'node',
  verbose: true,
  clearMocks: true,
  // Make sure stray fixtures or generators are not picked up as tests.
  testPathIgnorePatterns: ['/node_modules/', '/coverage/', '/tests/property/generators/'],

  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      rootDir: __dirname,
      testMatch: ['<rootDir>/tests/unit/**/*.test.js'],
      testPathIgnorePatterns: ['/node_modules/', '/coverage/'],
    },
    {
      displayName: 'property',
      testEnvironment: 'node',
      rootDir: __dirname,
      testMatch: ['<rootDir>/tests/property/**/*.test.js'],
      // Property tests can shrink for a while; allow up to 60s per test.
      testTimeout: 60000,
      // Configure fast-check (numRuns, FC_SEED) before any property test runs.
      setupFiles: ['<rootDir>/tests/setup/fast-check-config.js'],
      testPathIgnorePatterns: [
        '/node_modules/',
        '/coverage/',
        '/tests/property/generators/',
      ],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      rootDir: __dirname,
      testMatch: ['<rootDir>/tests/integration/**/*.test.js'],
      // Integration suites talk to PG/Redis/MinIO; allow extra headroom.
      testTimeout: 30000,
      testPathIgnorePatterns: ['/node_modules/', '/coverage/'],
    },
  ],
};
