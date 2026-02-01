import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

/**
 * Get application root directory
 * Priority: TRIM_APPDEST > APPROOT > process.cwd()
 * 
 * @returns Application root directory path
 */
function getAppRoot(): string {
  // Priority 1: TRIM_APPDEST (fnOS environment variable)
  if (process.env.TRIM_APPDEST) {
    return process.env.TRIM_APPDEST;
  }
  
  // Priority 2: APPROOT (if project uses this convention)
  if (process.env.APPROOT) {
    return process.env.APPROOT;
  }
  
  // Fallback: current working directory
  return process.cwd();
}

/**
 * Resolve 7z executable path
 * Priority: bundled 7zz (x64 > arm64) > system 7zz/7z
 * 
 * @returns Absolute path to 7z executable or command name
 * @throws Error if 7z not found
 */
export async function resolve7zPath(): Promise<string> {
  const platform = os.platform();
  const arch = os.arch();

  // Only support Linux
  if (platform !== 'linux') {
    throw new Error(`Unsupported platform: ${platform}. This application only supports Linux/WSL.`);
  }

  // Get application root
  const appRoot = getAppRoot();
  
  // Build candidate paths
  const candidates: string[] = [];
  
  // Priority 1: Bundled 7zz (x64 first, then arm64)
  if (arch === 'x64') {
    candidates.push(path.join(appRoot, 'server', 'vendor', '7zip', 'linux-x64', '7zz'));
    candidates.push(path.join(appRoot, 'server', 'vendor', '7zip', 'linux-arm64', '7zz'));
  } else if (arch === 'arm64') {
    candidates.push(path.join(appRoot, 'server', 'vendor', '7zip', 'linux-arm64', '7zz'));
    candidates.push(path.join(appRoot, 'server', 'vendor', '7zip', 'linux-x64', '7zz'));
  } else {
    // For other architectures, try both
    candidates.push(path.join(appRoot, 'server', 'vendor', '7zip', 'linux-x64', '7zz'));
    candidates.push(path.join(appRoot, 'server', 'vendor', '7zip', 'linux-arm64', '7zz'));
  }
  
  // Priority 2: System commands (fallback)
  // In Docker Alpine, p7zip provides '7z' command, so try it first
  // Also try '7zz' for systems that have the newer 7-Zip version
  candidates.push('7z');
  candidates.push('7zz');

  // Try each candidate
  for (const candidate of candidates) {
    // If candidate is a system command name (not a path)
    if (candidate === '7zz' || candidate === '7z') {
      // Check if command exists in PATH
      const result = spawnSync('which', [candidate], {
        encoding: 'utf8',
        stdio: 'pipe'
      });

      if (result.status === 0 && result.stdout.trim()) {
        const resolvedPath = result.stdout.trim();
        // Verify the resolved path exists
        if (fs.existsSync(resolvedPath)) {
          console.log(`[Boot] 7z resolved to: ${resolvedPath}`);
          return resolvedPath;
        }
      }
    } else {
      // Candidate is a file path
      const absolutePath = path.isAbsolute(candidate) 
        ? candidate 
        : path.resolve(candidate);
      
      if (fs.existsSync(absolutePath)) {
        // Ensure executable permission
        try {
          fs.chmodSync(absolutePath, 0o755);
        } catch (err) {
          // Ignore chmod errors (may not have permission, but file exists)
        }
        const resolvedPath = path.resolve(absolutePath);
        console.log(`[Boot] 7z resolved to: ${resolvedPath}`);
        return resolvedPath;
      }
    }
  }

  // Not found - print diagnostic information
  console.error('[Boot] 7z resolution failed');
  console.error(`TRIM_APPDEST=${process.env.TRIM_APPDEST || '(not set)'}`);
  console.error(`APPROOT=${process.env.APPROOT || '(not set)'}`);
  console.error(`cwd=${process.cwd()}`);
  console.error(`appRoot=${appRoot}`);
  console.error(`candidates=${JSON.stringify(candidates)}`);
  
  throw new Error(
    '7z not found: bundled 7zz missing and system 7z/7zz not installed. ' +
    'On Debian/Ubuntu: sudo apt install p7zip-full'
  );
}
