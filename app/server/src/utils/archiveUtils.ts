import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

/**
 * Normalize path for comparison (ignore case and path separators)
 */
function normalizePathForComparison(p: string): string {
  if (!p) return '';
  return p.replace(/\\/g, '/').toLowerCase().trim();
}

/**
 * List archive entry paths using 7z list command
 * Parse by blocks to only extract actual entry paths, not archive file path
 */
export function listArchivePaths(sevenZip: string, archivePath: string): string[] {
  try {
    const result = spawnSync(sevenZip, ['l', '-slt', '--', archivePath], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });

    if (result.error) {
      throw new Error(`Failed to execute 7z list: ${result.error.message}`);
    }

    if (result.status !== 0) {
      throw new Error(`7z list command failed with code ${result.status}`);
    }

    if (!result.stdout || result.stdout.trim() === '') {
      throw new Error('7z list command returned empty output');
    }

    // Parse output by blocks (separated by empty lines)
    const paths: string[] = [];
    const seen = new Set<string>();
    const normalizedArchivePath = normalizePathForComparison(archivePath);
    
    // Split into blocks by empty lines
    const blocks = result.stdout.split(/\n\s*\n/);
    
    for (const block of blocks) {
      const lines = block.split('\n');
      let candidatePath: string | null = null;
      let hasEntryField = false;
      
      // Scan block for Path and entry fields
      for (const line of lines) {
        const trimmed = line.trim();
        
        if (trimmed.startsWith('Path = ')) {
          candidatePath = trimmed.substring(7).trim();
        } else if (trimmed.startsWith('Size = ') || 
                   trimmed.startsWith('Folder = ') || 
                   trimmed.startsWith('Attributes = ')) {
          hasEntryField = true;
        }
      }
      
      // Only include if:
      // 1. Has a candidate path
      // 2. Block contains at least one entry field (Size/Folder/Attributes)
      // 3. Path is not empty
      // 4. Path is not the archive file itself
      if (candidatePath && hasEntryField && candidatePath.length > 0) {
        const normalizedCandidate = normalizePathForComparison(candidatePath);
        
        // Skip if this is the archive file path itself
        if (normalizedCandidate === normalizedArchivePath) {
          continue;
        }
        
        // Deduplicate while preserving order
        if (!seen.has(candidatePath)) {
          seen.add(candidatePath);
          paths.push(candidatePath);
        }
      }
    }

    return paths;
  } catch (err: any) {
    throw new Error(`Failed to list archive entries: ${err.message}`);
  }
}

export interface PathUnsafeCheck {
  unsafe: boolean;
  reason?: string;
}

type EscapeHit = { full: string; real: string };

/**
 * Check if an archive entry path is unsafe (Zip Slip detection)
 */
export function isArchiveEntryPathUnsafe(p: string): PathUnsafeCheck {
  if (!p || typeof p !== 'string') {
    return { unsafe: true, reason: 'invalid path' };
  }

  // Check for NUL character or control characters
  if (p.includes('\0')) {
    return { unsafe: true, reason: 'NUL character' };
  }

  // Check for path too long (DoS protection)
  if (p.length > 4096) {
    return { unsafe: true, reason: 'path too long' };
  }

  // Check for absolute paths (POSIX)
  if (p.startsWith('/')) {
    return { unsafe: true, reason: 'absolute path' };
  }

  // Check for parent traversal (../ or ..\)
  // Direct check for ../ or ..\
  if (/(^|[\/\\])\.\.([\/\\]|$)/.test(p)) {
    return { unsafe: true, reason: 'parent traversal' };
  }

  // Normalize and check again
  // Convert backslashes to forward slashes for normalization
  const normalized = path.posix.normalize(p.replace(/\\/g, '/'));
  
  if (normalized.startsWith('../') || normalized === '..' || normalized.includes('/../')) {
    return { unsafe: true, reason: 'parent traversal (normalized)' };
  }

  // Safe path
  return { unsafe: false };
}

/**
 * Assert no path escape using realpath verification
 */
export function assertNoEscape(dir: string): void {
  const base = fs.realpathSync(dir);
  
  // Normalize paths for comparison (POSIX: normalize separators)
  function normalizePath(p: string): string {
    if (!p) return '';
    return p.replace(/\\/g, '/');
  }
  
  const baseNormalized = normalizePath(base);
  // Ensure base ends with separator for prefix check
  const baseSep = baseNormalized.endsWith('/') ? baseNormalized : baseNormalized + '/';
  
  const escapeState: { value: EscapeHit | null } = { value: null };
  
  function walkDir(currentDir: string): void {
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      
      for (const entry of entries) {
        const full = path.join(currentDir, entry.name);
        
        try {
          const real = fs.realpathSync(full);
          const realNormalized = normalizePath(real);
          
          // Check if real path is within base directory
          // Allow: real === base or real starts with baseSep
          if (realNormalized !== baseNormalized && !realNormalized.startsWith(baseSep)) {
            if (escapeState.value === null) {
              escapeState.value = { full, real };
            }
            // Continue checking but record first escape
          }
          
          // Recursively check directories
          if (entry.isDirectory()) {
            walkDir(full);
          }
        } catch (err: any) {
          // Bad symlink or inaccessible entry - treat as risk
          throw new Error(`PATH_ESCAPE: Cannot resolve ${full}: ${err.message}`);
        }
      }
    } catch (err: any) {
      if (err.message && err.message.startsWith('PATH_ESCAPE:')) {
        throw err;
      }
      // Other errors (permission, etc.) - treat as risk
      throw new Error(`PATH_ESCAPE: Cannot access ${currentDir}: ${err.message}`);
    }
  }
  
  walkDir(dir);
  
  if (escapeState.value !== null) {
    throw new Error(`PATH_ESCAPE: ${escapeState.value.full} -> ${escapeState.value.real}`);
  }
  // If escapeState.value is null but we reach here, no escape was found (expected behavior)
}

/**
 * Copy directory recursively (fallback for cross-device rename)
 */
export function copyDirRecursive(src: string, dest: string): void {
  // Ensure destination parent exists
  const destParent = path.dirname(dest);
  if (!fs.existsSync(destParent)) {
    fs.mkdirSync(destParent, { recursive: true });
  }
  
  // Create destination directory
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

