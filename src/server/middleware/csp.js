'use strict';

/**
 * Content Security Policy middleware via Helmet.
 *
 * Generates a random nonce per request and configures Helmet's CSP directives
 * to allow only trusted sources. The nonce is attached to `res.locals.cspNonce`
 * for use in EJS templates (inline scripts must include `nonce="<%= cspNonce %>"`).
 *
 * References:
 *   - requirements.md §20.4 — CSP header configuration
 *   - design.md "Web Shell" — helmet with nonce-based script-src
 */

const crypto = require('crypto');

const helmet = require('helmet');

const { getEnv } = require('../../shared/env');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the hostname from the S3_ENDPOINT URL for use in img-src.
 * Falls back to empty string if parsing fails.
 *
 * @returns {string}
 */
function getS3Hostname() {
  try {
    const env = getEnv();
    const url = new URL(env.S3_ENDPOINT);
    return url.host;
  } catch (_e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that:
 *   1. Generates a cryptographic nonce and attaches it to res.locals.cspNonce
 *   2. Applies Helmet with a strict Content Security Policy
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function helmetMiddleware(req, res, next) {
  // Generate a random nonce for this request
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;

  const s3Host = getS3Hostname();

  const imgSrc = ["'self'", 'data:'];
  if (s3Host) {
    imgSrc.push(s3Host);
  }

  const helmetHandler = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", `'nonce-${nonce}'`, 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc,
        connectSrc: ["'self'", 'wss:'],
        frameAncestors: ["'none'"],
      },
    },
    // Disable crossOriginEmbedderPolicy for compatibility with external images
    crossOriginEmbedderPolicy: false,
  });

  helmetHandler(req, res, next);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  helmetMiddleware,
};
