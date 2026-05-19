'use strict';

/**
 * Gemini AI Provider — wrapper around @google/generative-ai for AI auto-reply.
 *
 * Implements the AIProvider interface defined in ai-provider.js:
 *   - generateReply(apiKey, systemPrompt, userMessage) → { text, tokensIn, tokensOut }
 *   - validateApiKey(apiKey) → boolean
 *
 * References:
 *   - requirements.md §8.1 — validate API key before saving
 *   - requirements.md §8.3 — call Gemini with system prompt + message
 *   - requirements.md §8.6 — record token usage
 *   - design.md "Auto-Reply Engine" — GeminiProvider as default AIProvider
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

const { ExternalServiceError } = require('../../../shared/errors');
const { getLogger } = require('../../../infra/logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = process.env.GEMINI_DEFAULT_MODEL || 'gemini-1.5-flash';

// ---------------------------------------------------------------------------
// Provider Implementation
// ---------------------------------------------------------------------------

/**
 * Generate a reply using Google Gemini.
 *
 * @param {string} apiKey - The tenant's Gemini API key
 * @param {string} systemPrompt - The tenant's system prompt for context
 * @param {string} userMessage - The incoming user message to respond to
 * @returns {Promise<{ text: string, tokensIn: number, tokensOut: number }>}
 * @throws {ExternalServiceError} On API failure
 */
async function generateReply(apiKey, systemPrompt, userMessage) {
  const log = getLogger();

  if (!apiKey || typeof apiKey !== 'string') {
    throw new ExternalServiceError('Gemini API key is required', {
      details: { service: 'gemini' },
    });
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: DEFAULT_MODEL });

    // Combine system prompt and user message into the content
    const prompt = systemPrompt
      ? `${systemPrompt}\n\nUser message: ${userMessage}`
      : userMessage;

    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();

    // Extract token usage from response metadata
    const usageMetadata = response.usageMetadata || {};
    const tokensIn = usageMetadata.promptTokenCount || 0;
    const tokensOut = usageMetadata.candidatesTokenCount || 0;

    log.info(
      { tokensIn, tokensOut, model: DEFAULT_MODEL },
      'gemini-provider: reply generated'
    );

    return { text, tokensIn, tokensOut };
  } catch (err) {
    log.error({ err, service: 'gemini' }, 'gemini-provider: generateReply failed');

    throw new ExternalServiceError(
      `Gemini API error: ${err.message || 'Unknown error'}`,
      {
        details: { service: 'gemini', raw: err.message },
        cause: err,
      }
    );
  }
}

/**
 * Validate a Gemini API key by making a minimal test call.
 *
 * @param {string} apiKey - The API key to validate
 * @returns {Promise<boolean>} true if valid, false if auth error
 * @throws {ExternalServiceError} On network/unexpected errors
 */
async function validateApiKey(apiKey) {
  const log = getLogger();

  if (!apiKey || typeof apiKey !== 'string') {
    return false;
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: DEFAULT_MODEL });

    // Make a minimal call to verify the key works
    await model.generateContent('Hello');
    return true;
  } catch (err) {
    // Check if it's an authentication/authorization error
    const status = err.status || err.httpCode || (err.response && err.response.status);
    const message = (err.message || '').toLowerCase();

    if (
      status === 401 ||
      status === 403 ||
      message.includes('api key') ||
      message.includes('invalid') ||
      message.includes('unauthorized') ||
      message.includes('permission')
    ) {
      log.info({ service: 'gemini' }, 'gemini-provider: API key validation failed (auth error)');
      return false;
    }

    // Non-auth errors are unexpected — log and throw
    log.error({ err, service: 'gemini' }, 'gemini-provider: validateApiKey unexpected error');
    throw new ExternalServiceError(
      `Gemini API validation error: ${err.message || 'Unknown error'}`,
      {
        details: { service: 'gemini', raw: err.message },
        cause: err,
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  generateReply,
  validateApiKey,
  DEFAULT_MODEL,
};
