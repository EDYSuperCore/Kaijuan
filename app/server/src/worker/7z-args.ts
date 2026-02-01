/**
 * 7z command line arguments builder
 * Only allows whitelisted parameters, no custom logic
 */

export type ConflictPolicy = "aoa" | "aos" | "aou" | "aot" | "none";
// Single letter suffix for overwrite mode (will be prefixed with -ao by build7zArgs)
export type OverwriteModeSuffix = "a" | "s" | "u" | "t";

export interface Build7zArgsInput {
  archivePath: string;
  outDir: string;
  overwriteMode?: ConflictPolicy | OverwriteModeSuffix; // Accept both full format and suffix
  yes?: boolean;
  password?: string; // Password for encrypted archives (7z syntax: -pPASSWORD, no space)
}

/**
 * Build 7z command line arguments
 * Only whitelisted parameters are allowed
 * 
 * @param input Input parameters
 * @returns Array of command line arguments
 * @throws Error if input validation fails
 */
export function build7zArgs(input: Build7zArgsInput): string[] {
  // Validate archivePath
  if (!input.archivePath || typeof input.archivePath !== 'string' || input.archivePath.trim() === '') {
    throw new Error('archivePath must be a non-empty string');
  }

  // Validate outDir
  if (!input.outDir || typeof input.outDir !== 'string' || input.outDir.trim() === '') {
    throw new Error('outDir must be a non-empty string');
  }

  // Validate overwriteMode if provided
  if (input.overwriteMode !== undefined) {
    const allowedFullModes: ConflictPolicy[] = ['aoa', 'aos', 'aou', 'aot', 'none'];
    const allowedSuffixes: OverwriteModeSuffix[] = ['a', 's', 'u', 't'];
    const mode = input.overwriteMode;
    if (!allowedFullModes.includes(mode as ConflictPolicy) && !allowedSuffixes.includes(mode as OverwriteModeSuffix)) {
      throw new Error(`Invalid overwriteMode: ${mode}. Allowed: aoa, aos, aou, aot, none (full) or a, s, u, t (suffix)`);
    }
  }

  // Build argv array: ["x", archivePath, "-o${outDir}", ...]
  const argv: string[] = [];

  // Fixed command: extract
  argv.push('x');

  // Archive path (no quotes, as-is)
  argv.push(input.archivePath);

  // Output directory (-o without space, as per 7z syntax)
  argv.push(`-o${input.outDir}`);

  // Overwrite mode (only if provided and not 'none')
  if (input.overwriteMode && input.overwriteMode !== 'none') {
    // If it's a single letter suffix, use it directly; otherwise extract suffix from full format
    const suffix = input.overwriteMode.length === 1 
      ? input.overwriteMode 
      : input.overwriteMode.substring(2); // Extract suffix from 'aoa' -> 'a', 'aos' -> 's', etc.
    argv.push(`-ao${suffix}`);
  }

  // Yes flag (assume yes to all queries)
  if (input.yes === true) {
    argv.push('-y');
  }

  // Password (only if provided and non-empty)
  // 7z syntax: -pPASSWORD (no space between -p and password)
  if (input.password !== undefined && input.password !== null && input.password !== '') {
    argv.push(`-p${input.password}`);
  }

  return argv;
}

