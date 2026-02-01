import * as sqlite3 from 'sqlite3';
import { dbRun } from './db';

/**
 * Run database migrations
 */
export async function migrate(db: sqlite3.Database): Promise<void> {
  // Create jobs table
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'draft',
      root_path TEXT NOT NULL,
      output_mode TEXT NOT NULL DEFAULT 'sibling_named_dir',
      output_dir TEXT,
      conflict_policy TEXT NOT NULL DEFAULT 'skip',
      concurrency INTEGER NOT NULL DEFAULT 1,
      options_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      total INTEGER NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      canceled INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      log_path TEXT
    )
  `);

  // Create job_items table
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS job_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      archive_path TEXT NOT NULL,
      archive_group_json TEXT,
      ext TEXT NOT NULL,
      out_dir TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt INTEGER NOT NULL DEFAULT 0,
      failed_reason TEXT,
      failed_detail TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    )
  `);

  // Create indexes
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at)
  `);

  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_items_job_status ON job_items(job_id, status)
  `);

  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_items_job ON job_items(job_id)
  `);

  // Create settings table (single row table)
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      conflict TEXT NOT NULL,
      outputMode TEXT NOT NULL,
      zipSlipPolicy TEXT NOT NULL,
      commonPasswords TEXT,
      passwordMasking INTEGER NOT NULL DEFAULT 1,
      updatedAt INTEGER NOT NULL
    )
  `);

  // Migrate: Add commonPasswords and passwordMasking columns if they don't exist
  try {
    await dbRun(db, `ALTER TABLE settings ADD COLUMN commonPasswords TEXT`);
  } catch (err: any) {
    // Column may already exist, ignore
    if (!err.message.includes('duplicate column')) {
      throw err;
    }
  }

  try {
    await dbRun(db, `ALTER TABLE settings ADD COLUMN passwordMasking INTEGER NOT NULL DEFAULT 1`);
  } catch (err: any) {
    // Column may already exist, ignore
    if (!err.message.includes('duplicate column')) {
      throw err;
    }
  }

  // Migrate: Add retry_from_job_id column if it doesn't exist
  try {
    await dbRun(db, `ALTER TABLE jobs ADD COLUMN retry_from_job_id INTEGER`);
  } catch (err: any) {
    // Column may already exist, ignore
    if (!err.message.includes('duplicate column')) {
      throw err;
    }
  }
}
