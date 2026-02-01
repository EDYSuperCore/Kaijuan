/**
 * Safe JSON parsing utility
 * Prevents crashes from malformed JSON in database or user input
 */

/**
 * Safely parse JSON string with error handling
 * @param json JSON string to parse (can be null/undefined)
 * @param defaultValue Default value to return if parsing fails
 * @returns Parsed object or default value
 */
export function safeJsonParse<T>(json: string | null | undefined, defaultValue: T): T {
  if (!json || typeof json !== 'string' || json.trim() === '') {
    return defaultValue;
  }

  try {
    return JSON.parse(json) as T;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[safeJsonParse] Failed to parse JSON:', {
      error: error.message,
      jsonLength: json.length,
      jsonPreview: json.substring(0, 100)
    });
    return defaultValue;
  }
}
