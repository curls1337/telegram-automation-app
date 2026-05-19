/**
 * ESLint flat config (eslint v9+) untuk Telegram Automation App.
 *
 * Strategi:
 *   - Gunakan `@eslint/js` (built-in) sebagai baseline.
 *   - Tambahkan `eslint-config-standard` via @eslint/eslintrc FlatCompat
 *     bila package tersedia (hot-swap antara airbnb-base / standard
 *     boleh dilakukan; lihat catatan di bawah).
 *   - Tambahkan rule custom multi-tenant guard untuk mencegah pola
 *     `xxx.where({ ... })` tanpa filter `tenant_id` (Requirement 3.2).
 *
 * Pilihan style:
 *   - Default: standard (`eslint-config-standard`). Untuk pakai
 *     `airbnb-base`, ganti string 'standard' di compat.extends().
 *   - Jika package style belum terpasang, config tetap valid: baseline
 *     `@eslint/js` recommended + custom guard tetap aktif.
 *
 * Custom multi-tenant guard (Requirement 3.2):
 *   - Pola `.where({ ... })` tanpa property `tenant_id` / `tenantId`
 *     → ERROR.
 *   - Pola `knex('table')`, `db('table')`, `trx('table')` di module
 *     domain → ERROR. Wajib lewat tenant-scoped repo helper di
 *     `src/infra/db.js` (lihat design.md §Components #3, #4).
 *   - Folder infra/migrations/scripts dikecualikan via override.
 *
 * Catatan keterbatasan heuristik AST:
 *   - Tidak menangkap `.where(builderFn)`, `.where('col', val)` literal
 *     positional, atau `.whereRaw(...)`.
 *   - Defense-in-depth utama tetap di runtime: repo helper di Phase 2
 *     menolak query tanpa tenant_id (lihat task 2.1, design §4 #3).
 */

const js = require('@eslint/js');
const globals = require('globals');

// Optional integrations: dimuat jika package tersedia.
// Tujuan: config tetap usable jika developer belum `npm install` style guide.
let standardCompatConfigs = [];
try {
  // eslint-disable-next-line global-require
  const { FlatCompat } = require('@eslint/eslintrc');
  const compat = new FlatCompat({
    baseDirectory: __dirname,
    resolvePluginsRelativeTo: __dirname,
    recommendedConfig: js.configs.recommended,
  });
  // Ganti 'standard' menjadi 'airbnb-base' bila tim memutuskan pakai airbnb.
  standardCompatConfigs = compat.extends('standard');
} catch (_err) {
  // FlatCompat / eslint-config-standard belum terpasang —
  // fall back ke baseline @eslint/js. `npm run lint` tetap jalan.
  standardCompatConfigs = [];
}

/**
 * Selector AST: setiap CallExpression `.where` dengan argument pertama
 * ObjectExpression yang TIDAK punya property `tenant_id` / `tenantId`
 * (baik shorthand identifier key maupun string literal key).
 */
const TENANT_ID_GUARD_SELECTOR =
  "CallExpression[callee.property.name='where']" +
  "[arguments.0.type='ObjectExpression']" +
  ":not(:has(Property[key.name='tenant_id']))" +
  ":not(:has(Property[key.name='tenantId']))" +
  ":not(:has(Property[key.value='tenant_id']))" +
  ":not(:has(Property[key.value='tenantId']))";

const NO_TENANT_ID_WHERE = {
  selector: TENANT_ID_GUARD_SELECTOR,
  message:
    "Query .where({...}) wajib menyertakan `tenant_id` untuk menjaga isolasi multi-tenant (Requirement 3.2). Gunakan tenant-scoped repo helper di src/infra/db.js, atau tambahkan tenant_id ke predikat.",
};

const NO_RAW_KNEX_TABLE_CALL = {
  selector:
    "CallExpression[callee.type='Identifier'][callee.name=/^(knex|db|trx)$/][arguments.0.type='Literal']",
  message:
    "Hindari memanggil `knex('table')` langsung di module domain. Pakai repository helper tenant-scoped di src/infra/db.js (Requirement 3.2).",
};

module.exports = [
  // Global ignore (flat config tidak baca .eslintignore)
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'coverage/**',
      'public/**',
      '**/*.min.js',
      '.kiro/**',
    ],
  },

  // ESLint recommended baseline (selalu aktif)
  js.configs.recommended,

  // eslint-config-standard (atau airbnb-base) bila tersedia
  ...standardCompatConfigs,

  // Project-wide rules + multi-tenant guard
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.es2023,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],

      // Requirement 3.2 — multi-tenant isolation safety guards
      'no-restricted-syntax': ['error', NO_TENANT_ID_WHERE, NO_RAW_KNEX_TABLE_CALL],
    },
  },

  // Layer infra/migrations/scripts: bypass tenant guard (pemilik raw query)
  {
    files: [
      'src/infra/**/*.js',
      'src/shared/**/*.js',
      'migrations/**/*.js',
      'scripts/**/*.js',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // Tests: relax sebagian rule
  {
    files: ['tests/**/*.js', '**/*.test.js', '**/*.spec.js'],
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.node,
      },
    },
    rules: {
      'no-restricted-syntax': 'off',
      'no-unused-expressions': 'off',
    },
  },
];
