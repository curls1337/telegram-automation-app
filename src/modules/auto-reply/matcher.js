'use strict';

/**
 * Auto-Reply Matcher — evaluates whether a message matches a rule's trigger.
 *
 * Responsibilities:
 *   - Match incoming message text against rule triggers (exact/contains/regex)
 *   - Honor case_sensitive flag
 *   - LRU cache for compiled regex patterns (max 200 entries)
 *
 * References:
 *   - requirements.md §7.4 — case-sensitive matching option
 *   - design.md "Auto-Reply Engine" — rule matching: exact, contains, regex
 */

// ---------------------------------------------------------------------------
// LRU Cache for compiled regex
// ---------------------------------------------------------------------------

const MAX_CACHE_SIZE = 200;

/**
 * Simple LRU cache for compiled RegExp objects.
 * Key format: `${pattern}::${flags}` to differentiate case-sensitive variants.
 */
class RegexLRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    /** @type {Map<string, RegExp>} */
    this.cache = new Map();
  }

  /**
   * Get a compiled regex from cache, or compile and cache it.
   *
   * @param {string} pattern
   * @param {string} flags
   * @returns {RegExp}
   */
  get(pattern, flags) {
    const key = `${pattern}::${flags}`;

    if (this.cache.has(key)) {
      // Move to end (most recently used)
      const value = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, value);
      return value;
    }

    // Compile new regex
    const regex = new RegExp(pattern, flags);

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, regex);
    return regex;
  }

  /**
   * Clear the cache. Useful for testing.
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Get current cache size.
   * @returns {number}
   */
  size() {
    return this.cache.size;
  }
}

/** Singleton regex cache instance */
const regexCache = new RegexLRUCache(MAX_CACHE_SIZE);

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

/**
 * Check if a message text matches a rule's trigger.
 *
 * @param {object} rule - The auto-reply rule object
 * @param {string} rule.trigger_kind - One of: exact, contains, regex
 * @param {string} rule.trigger_value - The trigger pattern
 * @param {boolean} rule.case_sensitive - Whether matching is case-sensitive
 * @param {string} messageText - The incoming message text
 * @returns {boolean} true if the message matches the rule
 */
function match(rule, messageText) {
  if (!messageText || typeof messageText !== 'string') {
    return false;
  }

  if (!rule || !rule.trigger_value || !rule.trigger_kind) {
    return false;
  }

  const { trigger_kind, trigger_value, case_sensitive } = rule;

  switch (trigger_kind) {
    case 'exact':
      return matchExact(trigger_value, messageText, case_sensitive);

    case 'contains':
      return matchContains(trigger_value, messageText, case_sensitive);

    case 'regex':
      return matchRegex(trigger_value, messageText, case_sensitive);

    default:
      return false;
  }
}

/**
 * Exact match: messageText must equal trigger_value exactly.
 *
 * @param {string} triggerValue
 * @param {string} messageText
 * @param {boolean} caseSensitive
 * @returns {boolean}
 */
function matchExact(triggerValue, messageText, caseSensitive) {
  if (caseSensitive) {
    return messageText === triggerValue;
  }
  return messageText.toLowerCase() === triggerValue.toLowerCase();
}

/**
 * Contains match: messageText must include trigger_value as a substring.
 *
 * @param {string} triggerValue
 * @param {string} messageText
 * @param {boolean} caseSensitive
 * @returns {boolean}
 */
function matchContains(triggerValue, messageText, caseSensitive) {
  if (caseSensitive) {
    return messageText.includes(triggerValue);
  }
  return messageText.toLowerCase().includes(triggerValue.toLowerCase());
}

/**
 * Regex match: compile the pattern (from cache) and test against messageText.
 * If case_sensitive is false, add 'i' flag.
 *
 * @param {string} pattern
 * @param {string} messageText
 * @param {boolean} caseSensitive
 * @returns {boolean}
 */
function matchRegex(pattern, messageText, caseSensitive) {
  try {
    const flags = caseSensitive ? '' : 'i';
    const regex = regexCache.get(pattern, flags);
    return regex.test(messageText);
  } catch (_err) {
    // If regex compilation fails at runtime (shouldn't happen since we
    // validate at create time), return false gracefully
    return false;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  match,
  regexCache,
  MAX_CACHE_SIZE,
};
