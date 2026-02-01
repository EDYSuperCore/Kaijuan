/**
 * Retry wrapper for SQLite operations that may encounter SQLITE_BUSY errors
 * Uses exponential backoff with capped delay
 */
export async function withSqliteRetry<T>(
  fn: () => Promise<T>,
  opts?: { retries?: number; baseDelayMs?: number }
): Promise<T> {
  const retries = opts?.retries ?? 8;
  const baseDelayMs = opts?.baseDelayMs ?? 50;
  let lastError: any;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      
      // Check if it's a SQLITE_BUSY error
      const isBusy = err.code === 'SQLITE_BUSY' || 
                     err.message?.includes('database is locked') ||
                     err.message?.includes('SQLITE_BUSY');
      
      if (!isBusy) {
        // Not a busy error, throw immediately
        throw err;
      }

      // If this was the last attempt, throw
      if (attempt >= retries) {
        throw err;
      }

      // Calculate exponential backoff delay (capped at 1000ms)
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), 1000);
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError;
}

