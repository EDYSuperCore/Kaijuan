/**
 * Password resolver utilities
 * Resolves password attempts based on password mode and settings
 */

import { PasswordMode, JobOptions, Settings } from '../domain/models';

export interface PasswordAttemptResult {
  attempts: string[];
  usedPasswordIndex?: number; // Index of used password (for select/try_list), or "manual" for manual mode
  successWithPassword: boolean;
  attemptsCount: number;
}

/**
 * Resolve password attempts from job options and settings
 * @param options Job options
 * @param settingsCommonPasswords Common passwords from settings
 * @returns Array of passwords to try (in order)
 */
export function resolvePasswordAttempts(
  options: JobOptions,
  settingsCommonPasswords: string[] = []
): string[] {
  const mode: PasswordMode = options.passwordMode || 'none';

  switch (mode) {
    case 'none':
      return [];

    case 'manual':
      if (!options.passwordValue || options.passwordValue.trim() === '') {
        throw new Error('passwordMode=manual requires passwordValue to be non-empty');
      }
      return [options.passwordValue];

    case 'select':
      if (options.passwordRefIndex === undefined || options.passwordRefIndex === null) {
        throw new Error('passwordMode=select requires passwordRefIndex');
      }
      if (options.passwordRefIndex < 0 || options.passwordRefIndex >= settingsCommonPasswords.length) {
        throw new Error(`passwordRefIndex ${options.passwordRefIndex} is out of range [0, ${settingsCommonPasswords.length})`);
      }
      return [settingsCommonPasswords[options.passwordRefIndex]];

    case 'try_list':
      if (settingsCommonPasswords.length === 0) {
        throw new Error('passwordMode=try_list requires commonPasswords to be non-empty');
      }
      return [...settingsCommonPasswords]; // Return copy of array

    default:
      throw new Error(`Unknown passwordMode: ${mode}`);
  }
}

/**
 * Check if error is password-related
 * @param stdout 7z stdout output
 * @param stderr 7z stderr output
 * @returns true if error is password-related
 */
export function isPasswordError(stdout: string, stderr: string): boolean {
  const combined = (stdout + stderr).toLowerCase();
  
  // Common password error patterns in 7z
  const passwordErrorPatterns = [
    'wrong password',
    'can not open encrypted archive',
    'data error',
    'incorrect password',
    'password is wrong',
    'wrong pass',
    'bad password'
  ];

  return passwordErrorPatterns.some(pattern => combined.includes(pattern));
}


