'use strict';

/**
 * AI Provider Interface — contract for AI auto-reply providers.
 *
 * This module defines the expected interface that any AI provider must
 * implement. The default implementation is GeminiProvider (gemini-provider.js).
 *
 * Any provider must expose:
 *   - generateReply(apiKey, systemPrompt, userMessage) → Promise<{ text, tokensIn, tokensOut }>
 *   - validateApiKey(apiKey) → Promise<boolean>
 *
 * References:
 *   - requirements.md §8.3 — AI fallback using Google Gemini
 *   - design.md "Auto-Reply Engine" — AIProvider abstraction
 */

/**
 * @typedef {Object} AIReplyResult
 * @property {string} text - The generated reply text
 * @property {number} tokensIn - Number of input/prompt tokens consumed
 * @property {number} tokensOut - Number of output/candidate tokens generated
 */

/**
 * @typedef {Object} AIProvider
 * @property {(apiKey: string, systemPrompt: string, userMessage: string) => Promise<AIReplyResult>} generateReply
 *   Generate a reply given a system prompt and user message.
 *   Throws ExternalServiceError on failure.
 * @property {(apiKey: string) => Promise<boolean>} validateApiKey
 *   Validate that the given API key is functional by making a test call.
 *   Returns true if the key is valid, false if authentication fails.
 *   Throws ExternalServiceError on network/unexpected errors.
 */

module.exports = {};
