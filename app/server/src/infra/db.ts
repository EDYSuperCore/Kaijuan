import * as sqlite3 from 'sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { withSqliteRetry } from './withSqliteRetry';

let dbInstance: sqlite3.Database | null = null;

/**
 * Get var directory
 */
export function getVarDir(): string {
  const envVarDir = process.env.APP_VAR_DIR;
  if (envVarDir) {
    return envVarDir;
  }
  // Local development fallback
  return path.join(process.cwd(), '.local-var');
}

/**
 * Ensure directory exists
 */
export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Open database connection
 */
export function openDb(): sqlite3.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const varDir = getVarDir();
  const dataDir = path.join(varDir, 'data');
  ensureDir(dataDir);

  const dbPath = path.join(dataDir, 'app.db');
  dbInstance = new sqlite3.Database(dbPath);
  
  // Configure busy_timeout to handle concurrent access
  // 5000ms = 5 seconds
  dbInstance.configure('busyTimeout', 5000);
  
  return dbInstance;
}

/**
 * Get database instance
 */
export function getDb(): sqlite3.Database {
  if (!dbInstance) {
    return openDb();
  }
  return dbInstance;
}

/**
 * Run function in transaction (with retry for SQLITE_BUSY)
 */
export function runInTx<T>(db: sqlite3.Database, fn: () => Promise<T>): Promise<T> {
  return withSqliteRetry(() => {
    return new Promise<T>((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION', (err) => {
          if (err) {
            reject(err);
            return;
          }

          fn()
            .then((result) => {
              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  reject(commitErr);
                } else {
                  resolve(result);
                }
              });
            })
            .catch((error) => {
              db.run('ROLLBACK', () => {
                reject(error);
              });
            });
        });
      });
    });
  });
}

/**
 * Promisify db.run (with retry for SQLITE_BUSY)
 */
export function dbRun(db: sqlite3.Database, sql: string, params: any[] = []): Promise<{ lastID?: number; changes: number }> {
  return withSqliteRetry(() => {
    return new Promise<{ lastID?: number; changes: number }>((resolve, reject) => {
      db.run(sql, params, function(err) {
        if (err) {
          reject(err);
        } else {
          resolve({ lastID: this.lastID, changes: this.changes });
        }
      });
    });
  });
}

/**
 * Promisify db.get
 */
export function dbGet<T>(db: sqlite3.Database, sql: string, params: any[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row as T | undefined);
      }
    });
  });
}

/**
 * Promisify db.all
 */
export function dbAll<T>(db: sqlite3.Database, sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows as T[]);
      }
    });
  });
}
