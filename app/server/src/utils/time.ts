/**
 * Get current timestamp in milliseconds
 */
export function now(): number {
  return Date.now();
}

/**
 * Format timestamp to ISO string
 */
export function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

