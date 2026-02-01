import * as sqlite3 from 'sqlite3';
import { dbGet, dbRun } from '../infra/db';
import { Settings, DEFAULT_SETTINGS } from '../domain/models';
import { now } from '../utils/time';

/**
 * Get current settings
 * Returns null if not found in DB (does not auto-insert default settings)
 */
export async function getSettings(db: sqlite3.Database): Promise<Settings | null> {
  const row = await dbGet<{
    conflict: string;
    outputMode: string;
    zipSlipPolicy: string;
    commonPasswords: string | null;
    passwordMasking: number | null;
    updatedAt: number;
  }>(db, 'SELECT conflict, outputMode, zipSlipPolicy, commonPasswords, passwordMasking, updatedAt FROM settings WHERE id = 1', []);

  if (!row) {
    return null; // Do not auto-insert default settings
  }

  // Parse commonPasswords JSON
  let commonPasswords: string[] = [];
  if (row.commonPasswords) {
    try {
      commonPasswords = JSON.parse(row.commonPasswords);
    } catch (err) {
      // Invalid JSON, use empty array
      commonPasswords = [];
    }
  }

  return {
    conflict: row.conflict as Settings['conflict'],
    outputMode: row.outputMode as Settings['outputMode'],
    zipSlipPolicy: row.zipSlipPolicy as Settings['zipSlipPolicy'],
    commonPasswords: commonPasswords,
    passwordMasking: row.passwordMasking !== null ? row.passwordMasking === 1 : true,
    updatedAt: row.updatedAt
  };
}

/**
 * Update settings
 * Validates input and updates DB
 */
export async function updateSettings(
  db: sqlite3.Database,
  updates: Partial<Omit<Settings, 'updatedAt'>>
): Promise<Settings> {
  // Validate conflict
  if (updates.conflict !== undefined) {
    if (!['skip', 'overwrite', 'rename'].includes(updates.conflict)) {
      throw new Error(`Invalid conflict value: ${updates.conflict}. Must be one of: skip, overwrite, rename`);
    }
  }

  // Validate outputMode
  if (updates.outputMode !== undefined) {
    if (!['sibling_named_dir', 'in_place', 'custom'].includes(updates.outputMode)) {
      throw new Error(`Invalid outputMode value: ${updates.outputMode}. Must be one of: sibling_named_dir, in_place, custom`);
    }
  }

  // Validate zipSlipPolicy
  if (updates.zipSlipPolicy !== undefined) {
    if (!['block', 'allow'].includes(updates.zipSlipPolicy)) {
      throw new Error(`Invalid zipSlipPolicy value: ${updates.zipSlipPolicy}. Must be one of: block, allow`);
    }
  }

  // Validate commonPasswords
  if (updates.commonPasswords !== undefined) {
    if (!Array.isArray(updates.commonPasswords)) {
      throw new Error('commonPasswords must be an array');
    }
    // Validate each password is a string
    for (const pwd of updates.commonPasswords) {
      if (typeof pwd !== 'string') {
        throw new Error('All commonPasswords items must be strings');
      }
    }
  }

  // Validate passwordMasking
  if (updates.passwordMasking !== undefined) {
    if (typeof updates.passwordMasking !== 'boolean') {
      throw new Error('passwordMasking must be a boolean');
    }
  }

  // Get current settings
  const current = await getSettings(db);

  // If no existing settings, create new one
  // Note: PUT /api/settings handler ensures all fields are provided, so we can safely use updates directly
  if (!current) {
    // Require all fields when creating new settings (PUT handler should ensure this)
    if (updates.conflict === undefined || updates.outputMode === undefined || updates.zipSlipPolicy === undefined) {
      throw new Error('All settings fields (conflict, outputMode, zipSlipPolicy) must be provided when creating new settings.');
    }
    
    const newSettings: Settings = {
      conflict: updates.conflict,
      outputMode: updates.outputMode,
      zipSlipPolicy: updates.zipSlipPolicy,
      commonPasswords: updates.commonPasswords || [],
      passwordMasking: updates.passwordMasking !== undefined ? updates.passwordMasking : true,
      updatedAt: now()
    };
    
    const commonPasswordsJson = JSON.stringify(newSettings.commonPasswords || []);
    await dbRun(
      db,
      'INSERT INTO settings (id, conflict, outputMode, zipSlipPolicy, commonPasswords, passwordMasking, updatedAt) VALUES (1, ?, ?, ?, ?, ?, ?)',
      [newSettings.conflict, newSettings.outputMode, newSettings.zipSlipPolicy, commonPasswordsJson, newSettings.passwordMasking ? 1 : 0, newSettings.updatedAt]
    );
    
    return newSettings;
  }

  // Update existing settings
  // PUT handler ensures all fields are provided, so use updates directly
  const newSettings: Settings = {
    conflict: updates.conflict!,
    outputMode: updates.outputMode!,
    zipSlipPolicy: updates.zipSlipPolicy!,
    commonPasswords: updates.commonPasswords !== undefined ? updates.commonPasswords : current.commonPasswords || [],
    passwordMasking: updates.passwordMasking !== undefined ? updates.passwordMasking : (current.passwordMasking !== undefined ? current.passwordMasking : true),
    updatedAt: now()
  };

  // Update DB
  const commonPasswordsJson = JSON.stringify(newSettings.commonPasswords || []);
  await dbRun(
    db,
    'UPDATE settings SET conflict = ?, outputMode = ?, zipSlipPolicy = ?, commonPasswords = ?, passwordMasking = ?, updatedAt = ? WHERE id = 1',
    [newSettings.conflict, newSettings.outputMode, newSettings.zipSlipPolicy, commonPasswordsJson, newSettings.passwordMasking ? 1 : 0, newSettings.updatedAt]
  );

  return newSettings;
}

