/**
 * 7z trace utilities
 * Provides debugging capabilities for 7z execution tracking
 * Controlled by KAIJUAN_7Z_TRACE environment variable (default: disabled)
 */

import * as fs from 'fs';
import * as path from 'path';
import { realpathSync } from 'fs';

/**
 * Check if 7z trace is enabled
 */
export function is7zTraceEnabled(): boolean {
  return process.env.KAIJUAN_7Z_TRACE === '1';
}

/**
 * Get trace directory path
 */
export function getTraceDir(): string {
  return '/tmp/kaijuan-7z-trace';
}

/**
 * Ensure trace directory exists
 */
export function ensureTraceDir(): void {
  const traceDir = getTraceDir();
  if (!fs.existsSync(traceDir)) {
    fs.mkdirSync(traceDir, { recursive: true });
  }
}

/**
 * Resolve realpath of a file/directory
 */
export function resolveRealPath(p: string): string {
  try {
    return realpathSync(p);
  } catch (err) {
    // If path doesn't exist, return original path
    return p;
  }
}

/**
 * Sample files from a directory (max 50, sorted by path)
 * Returns array of { path, size, mtime }
 */
export function sampleDirectory(dirPath: string, maxCount: number = 50): Array<{ path: string; size: number; mtime: number }> {
  const samples: Array<{ path: string; size: number; mtime: number }> = [];
  
  if (!fs.existsSync(dirPath)) {
    return samples; // Return empty array if directory doesn't exist
  }

  function walkDir(currentPath: string, relativeBase: string): void {
    if (samples.length >= maxCount) {
      return; // Stop if we've reached the limit
    }

    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      
      // Sort entries by name for deterministic sampling
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (samples.length >= maxCount) {
          break;
        }

        const fullPath = path.join(currentPath, entry.name);
        const relativePath = path.join(relativeBase, entry.name);

        if (entry.isFile()) {
          try {
            const stats = fs.statSync(fullPath);
            samples.push({
              path: relativePath,
              size: stats.size,
              mtime: stats.mtimeMs
            });
          } catch (err) {
            // Skip files that can't be stat'd
          }
        } else if (entry.isDirectory()) {
          walkDir(fullPath, relativePath);
        }
      }
    } catch (err) {
      // Skip directories that can't be read
    }
  }

  walkDir(dirPath, '');
  return samples;
}

/**
 * Write trace JSON file
 */
export function writeTraceFile(jobId: number, suffix: string, data: any): string {
  if (!is7zTraceEnabled()) {
    return '';
  }

  ensureTraceDir();
  const traceDir = getTraceDir();
  const filename = `${jobId}-${suffix}.json`;
  const filepath = path.join(traceDir, filename);
  
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
  return filepath;
}

/**
 * Log trace message (only if trace is enabled)
 */
export function traceLog(message: string, logStream?: { write: (msg: string) => void }): void {
  if (!is7zTraceEnabled()) {
    return;
  }
  
  const logMsg = `[7z.trace] ${message}\n`;
  
  if (logStream) {
    logStream.write(logMsg);
  }
  
  // Also output to console
  process.stdout.write(logMsg);
}

/**
 * Log stdout message (only if trace is enabled)
 */
export function traceStdout(line: string, logStream?: { write: (msg: string) => void }): void {
  if (!is7zTraceEnabled()) {
    return;
  }
  
  const logMsg = `[7z.stdout] ${line}\n`;
  
  if (logStream) {
    logStream.write(logMsg);
  }
  
  // Also output to console
  process.stdout.write(logMsg);
}

/**
 * Log stderr message (only if trace is enabled)
 */
export function traceStderr(line: string, logStream?: { write: (msg: string) => void }): void {
  if (!is7zTraceEnabled()) {
    return;
  }
  
  const logMsg = `[7z.stderr] ${line}\n`;
  
  if (logStream) {
    logStream.write(logMsg);
  }
  
  // Also output to console
  process.stdout.write(logMsg);
}

