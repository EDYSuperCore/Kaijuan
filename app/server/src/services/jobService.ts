import * as sqlite3 from 'sqlite3';
import * as path from 'path';
import { safeJsonParse } from '../utils/json-utils';
import { JobStatus, ItemStatus, FailedReason } from '../domain/states';
import { assertJobTransition, assertItemTransition } from '../domain/stateMachine';
import { CreateJobOptions, JobRow, JobItemRow, JobOptions, ConflictPolicy, OutputMode, DEFAULT_SETTINGS } from '../domain/models';
import { dbRun, dbGet, dbAll, runInTx, getVarDir, ensureDir } from '../infra/db';
import { now } from '../utils/time';

/**
 * Build JobOptions from request body and settings
 * Priority: explicit request > settings > DEFAULT_SETTINGS
 * Returns JobOptions with conflictPolicy (not conflict) field
 */
/**
 * Require and validate JobOptions from request body (no defaults, no DB fallback)
 * Pure function: only validates and normalizes field names, throws on missing fields
 */
export function requireJobOptionsFromRequest(reqBody: {
  rootPath: string;
  conflictPolicy?: ConflictPolicy; // Primary field name
  conflict?: ConflictPolicy; // Legacy field name (will be normalized to conflictPolicy)
  outputMode?: OutputMode;
  zipSlipPolicy?: 'block' | 'allow';
  passwordCandidates?: string[];
  [key: string]: any;
}): JobOptions {
  // Normalize conflictPolicy: accept both 'conflictPolicy' and 'conflict', prioritize 'conflictPolicy'
  const conflictPolicy: ConflictPolicy | undefined = reqBody.conflictPolicy ?? reqBody.conflict;
  
  // Validate required fields - throw immediately if missing (no defaults)
  const missingFields: string[] = [];
  if (!conflictPolicy) {
    missingFields.push('conflictPolicy');
  }
  if (!reqBody.outputMode) {
    missingFields.push('outputMode');
  }
  if (!reqBody.zipSlipPolicy) {
    missingFields.push('zipSlipPolicy');
  }
  
  if (missingFields.length > 0) {
    throw new Error(`MISSING_JOB_OPTIONS: ${missingFields.join(', ')}`);
  }
  
  // Validate enum values
  if (!['skip', 'overwrite', 'rename'].includes(conflictPolicy!)) {
    throw new Error(`Invalid conflictPolicy value: ${conflictPolicy}. Must be one of: skip, overwrite, rename`);
  }
  if (!['sibling_named_dir', 'in_place', 'custom'].includes(reqBody.outputMode!)) {
    throw new Error(`Invalid outputMode value: ${reqBody.outputMode}. Must be one of: sibling_named_dir, in_place, custom`);
  }
  if (!['block', 'allow'].includes(reqBody.zipSlipPolicy!)) {
    throw new Error(`Invalid zipSlipPolicy value: ${reqBody.zipSlipPolicy}. Must be one of: block, allow`);
  }
  
  // Build JobOptions: use conflictPolicy as primary field, include conflict for backward compatibility
  return {
    rootPath: reqBody.rootPath,
    outputMode: reqBody.outputMode!,
    conflictPolicy: conflictPolicy!, // Primary field name
    conflict: conflictPolicy!, // Backward compatibility field (for old workers)
    zipSlipPolicy: reqBody.zipSlipPolicy!,
    passwordCandidates: reqBody.passwordCandidates || []
  };
}

/**
 * Create a new job
 */
export async function createJob(
  db: sqlite3.Database,
  options: CreateJobOptions
): Promise<number> {
  return runInTx(db, async () => {
    const createdAt = now();

    // Build JobOptions - must be provided by API handler (no settings fallback)
    if (!options.options || !options.options.conflictPolicy || !options.options.outputMode || !options.options.zipSlipPolicy) {
      throw new Error('JobOptions must be fully resolved before calling createJob. Missing required fields: conflictPolicy, outputMode, or zipSlipPolicy');
    }
    
    // Use provided options directly (already validated by API layer)
    const jobOptions: JobOptions = {
      rootPath: options.rootPath,
      outputMode: options.options.outputMode,
      conflictPolicy: options.options.conflictPolicy,
      conflict: options.options.conflict ?? options.options.conflictPolicy, // Backward compatibility
      zipSlipPolicy: options.options.zipSlipPolicy,
      passwordCandidates: options.options.passwordCandidates || []
    };
    
    // Add outputDir if provided
    if (options.outputDir) {
      jobOptions.outputDir = options.outputDir;
    }

    const optionsJson = JSON.stringify(jobOptions);

    // Calculate log path
    const varDir = getVarDir();
    ensureDir(path.join(varDir, 'logs'));

    // Insert job
    const jobResult = await dbRun(db, `
      INSERT INTO jobs (
        status, root_path, output_mode, output_dir, conflict_policy, concurrency,
        options_json, created_at, total, log_path, retry_from_job_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      JobStatus.DRAFT,
      options.rootPath,
      jobOptions.outputMode, // Use resolved value from unified function
      options.outputDir || null,
      jobOptions.conflictPolicy, // Use resolved value from unified function
      options.concurrency || 1,
      optionsJson,
      createdAt,
      options.items.length,
      null, // log_path will be set after jobId is known
      options.retryFromJobId || null // retry_from_job_id
    ]);

    const jobId = jobResult.lastID!;
    const logPath = path.join(varDir, 'logs', `job-${jobId}.log`);

    // Update log_path
    await dbRun(db, 'UPDATE jobs SET log_path = ? WHERE id = ?', [logPath, jobId]);

    // Insert job items
    const stmt = db.prepare(`
      INSERT INTO job_items (
        job_id, archive_path, archive_group_json, ext, out_dir, status, created_at, attempt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of options.items) {
      stmt.run(
        jobId,
        item.archivePath,
        item.archiveGroupJson ? JSON.stringify(item.archiveGroupJson) : null,
        item.ext,
        item.outDir || null,
        ItemStatus.PENDING,
        createdAt,
        0
      );
    }

    stmt.finalize();

    return jobId;
  });
}

/**
 * Enqueue a job (draft/paused -> queued)
 */
export async function enqueueJob(db: sqlite3.Database, jobId: number): Promise<void> {
  return runInTx(db, async () => {
    const job = await dbGet<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    if (job.status === JobStatus.DRAFT || job.status === JobStatus.PAUSED) {
      assertJobTransition(job.status, JobStatus.QUEUED);
      await dbRun(db, 'UPDATE jobs SET status = ? WHERE id = ?', [JobStatus.QUEUED, jobId]);
    }
  });
}

/**
 * Request pause (running -> pausing)
 */
export async function requestPause(db: sqlite3.Database, jobId: number): Promise<void> {
  return runInTx(db, async () => {
    const job = await dbGet<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    if (job.status === JobStatus.RUNNING) {
      assertJobTransition(job.status, JobStatus.PAUSING);
      await dbRun(db, 'UPDATE jobs SET status = ? WHERE id = ?', [JobStatus.PAUSING, jobId]);
    }
  });
}

/**
 * Request cancel (queued/running/paused -> canceling)
 */
export async function requestCancel(db: sqlite3.Database, jobId: number): Promise<void> {
  return runInTx(db, async () => {
    const job = await dbGet<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    if ([JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.PAUSED].includes(job.status)) {
      assertJobTransition(job.status, JobStatus.CANCELING);
      await dbRun(db, 'UPDATE jobs SET status = ? WHERE id = ?', [JobStatus.CANCELING, jobId]);
    }
  });
}

/**
 * Retry a failed item
 */
export async function retryItem(db: sqlite3.Database, itemId: number): Promise<void> {
  return runInTx(db, async () => {
    const item = await dbGet<JobItemRow>(db, 'SELECT * FROM job_items WHERE id = ?', [itemId]);
    if (!item) {
      throw new Error(`Item ${itemId} not found`);
    }

    if (item.status === ItemStatus.FAILED) {
      assertItemTransition(item.status, ItemStatus.PENDING);
      await dbRun(db, `
        UPDATE job_items
        SET status = ?, attempt = attempt + 1, failed_reason = NULL, failed_detail = NULL,
            started_at = NULL, ended_at = NULL
        WHERE id = ?
      `, [ItemStatus.PENDING, itemId]);
    }
  });
}

/**
 * List jobs
 */
export async function listJobs(db: sqlite3.Database, limit: number = 50): Promise<JobRow[]> {
  return dbAll<JobRow>(db, 'SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?', [limit]);
}

/**
 * Get job by ID
 */
export async function getJob(db: sqlite3.Database, jobId: number): Promise<JobRow | undefined> {
  return dbGet<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
}

/**
 * List job items
 */
export async function listJobItems(
  db: sqlite3.Database,
  jobId: number,
  limit: number = 2000
): Promise<JobItemRow[]> {
  return dbAll<JobItemRow>(
    db,
    'SELECT * FROM job_items WHERE job_id = ? ORDER BY id LIMIT ?',
    [jobId, limit]
  );
}

/**
 * Finalize item (only allow running -> success/failed/skipped/canceled)
 * Updates job counts atomically
 */
export async function finalizeItem(
  db: sqlite3.Database,
  jobId: number,
  itemId: number,
  finalStatus: ItemStatus.SUCCESS | ItemStatus.FAILED | ItemStatus.SKIPPED | ItemStatus.CANCELED,
  failedReason?: FailedReason,
  failedDetail?: string
): Promise<void> {
  return runInTx(db, async () => {
    const item = await dbGet<JobItemRow>(db, 'SELECT * FROM job_items WHERE id = ?', [itemId]);
    if (!item) {
      throw new Error(`Item ${itemId} not found`);
    }

    if (item.status !== ItemStatus.RUNNING) {
      throw new Error(`Item ${itemId} is not in running status, cannot finalize`);
    }

    assertItemTransition(ItemStatus.RUNNING, finalStatus);

    // Update item
    const updates: string[] = ['status = ?', 'ended_at = ?'];
    const params: any[] = [finalStatus, now()];

    if (failedReason) {
      updates.push('failed_reason = ?');
      params.push(failedReason);
    }

    if (failedDetail) {
      updates.push('failed_detail = ?');
      params.push(failedDetail);
    }

    params.push(itemId);

    await dbRun(db, `UPDATE job_items SET ${updates.join(', ')} WHERE id = ?`, params);

    // Update job counts
    const fieldMap: Record<ItemStatus, string> = {
      [ItemStatus.SUCCESS]: 'success',
      [ItemStatus.FAILED]: 'failed',
      [ItemStatus.SKIPPED]: 'skipped',
      [ItemStatus.CANCELED]: 'canceled',
      [ItemStatus.PENDING]: 'success', // should not happen
      [ItemStatus.RUNNING]: 'success' // should not happen
    };

    const field = fieldMap[finalStatus];
    if (field) {
      await dbRun(db, `UPDATE jobs SET ${field} = ${field} + 1 WHERE id = ?`, [jobId]);
    }
  });
}

/**
 * CAS update job status (queued -> running)
 */
export async function casJobQueuedToRunning(
  db: sqlite3.Database,
  jobId: number
): Promise<boolean> {
  return runInTx(db, async () => {
    const job = await dbGet<JobRow>(db, 'SELECT * FROM jobs WHERE id = ? AND status = ?', [
      jobId,
      JobStatus.QUEUED
    ]);
    if (!job) {
      return false;
    }

    assertJobTransition(JobStatus.QUEUED, JobStatus.RUNNING);
    const startedAt = job.started_at || now();
    await dbRun(db, 'UPDATE jobs SET status = ?, started_at = ? WHERE id = ?', [
      JobStatus.RUNNING,
      startedAt,
      jobId
    ]);

    return true;
  });
}

/**
 * Get next queued job
 */
export async function getNextQueuedJob(db: sqlite3.Database): Promise<JobRow | undefined> {
  return dbGet<JobRow>(
    db,
    'SELECT * FROM jobs WHERE status = ? ORDER BY created_at ASC LIMIT 1',
    [JobStatus.QUEUED]
  );
}

/**
 * Get pending items for a job
 */
export async function getPendingItems(
  db: sqlite3.Database,
  jobId: number
): Promise<JobItemRow[]> {
  return dbAll<JobItemRow>(
    db,
    'SELECT * FROM job_items WHERE job_id = ? AND status = ? ORDER BY created_at ASC',
    [jobId, ItemStatus.PENDING]
  );
}

/**
 * Update job status
 */
export async function updateJobStatus(
  db: sqlite3.Database,
  jobId: number,
  from: JobStatus,
  to: JobStatus
): Promise<void> {
  return runInTx(db, async () => {
    const job = await dbGet<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    // Type guard ensures job is not undefined
    if (job.status !== from) {
      throw new Error(`Job ${jobId} status mismatch: expected ${from}, got ${job.status}`);
    }

    assertJobTransition(from, to);
    const endedAt = [JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELED].includes(to)
      ? now()
      : null;

    await dbRun(db, 'UPDATE jobs SET status = ?, ended_at = ? WHERE id = ?', [
      to,
      endedAt,
      jobId
    ]);
  });
}

/**
 * Update item status (pending -> running)
 */
export async function updateItemToRunning(
  db: sqlite3.Database,
  itemId: number
): Promise<void> {
  return runInTx(db, async () => {
    const item = await dbGet<JobItemRow>(db, 'SELECT * FROM job_items WHERE id = ?', [itemId]);
    if (!item) {
      throw new Error(`Item ${itemId} not found`);
    }

    if (item.status !== ItemStatus.PENDING) {
      throw new Error(`Item ${itemId} is not in pending status`);
    }

    assertItemTransition(ItemStatus.PENDING, ItemStatus.RUNNING);
    await dbRun(db, 'UPDATE job_items SET status = ?, started_at = ? WHERE id = ?', [
      ItemStatus.RUNNING,
      now(),
      itemId
    ]);
  });
}

/**
 * Cancel remaining pending items
 */
export async function cancelRemainingItems(
  db: sqlite3.Database,
  jobId: number
): Promise<number> {
  return runInTx(db, async () => {
    const result = await dbRun(db, `
      UPDATE job_items
      SET status = ?, ended_at = ?
      WHERE job_id = ? AND status = ?
    `, [
      ItemStatus.CANCELED,
      now(),
      jobId,
      ItemStatus.PENDING
    ]);

    // Update job canceled count
    await dbRun(db, `
      UPDATE jobs SET canceled = canceled + ? WHERE id = ?
    `, [result.changes, jobId]);

    return result.changes;
  });
}

/**
 * Terminal statuses that allow deletion
 */
const TERMINAL_STATUSES = [
  JobStatus.COMPLETED,
  JobStatus.FAILED,
  JobStatus.CANCELED
];

/**
 * Check if a job status is terminal (allows deletion)
 */
export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Delete a job (only if in terminal state: completed/failed/canceled)
 * Deletes job and all associated job_items (via CASCADE)
 * Does NOT delete files from filesystem
 */
export async function deleteJob(
  db: sqlite3.Database,
  jobId: number
): Promise<void> {
  return runInTx(db, async () => {
    // Check if job exists
    const job = await dbGet<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    // Check if job is in terminal state (only terminal statuses allow deletion)
    if (!isTerminalStatus(job.status as JobStatus)) {
      throw new Error('JOB_NOT_DELETABLE: Job is not in terminal state, cannot delete.');
    }

    // Delete job (job_items will be deleted automatically via CASCADE)
    await dbRun(db, 'DELETE FROM jobs WHERE id = ?', [jobId]);
  });
}

/**
 * Retry a failed job with new password options
 * Creates a new job based on the failed job, with new password strategy
 * @param db Database instance
 * @param failedJobId ID of the failed job to retry
 * @param passwordOptions New password options for retry
 * @returns ID of the new retry job
 */
export async function retryJob(
  db: sqlite3.Database,
  failedJobId: number,
  passwordOptions: {
    passwordMode: 'none' | 'select' | 'manual' | 'try_list';
    passwordValue?: string;
    passwordRefIndex?: number;
  }
): Promise<number> {
  return runInTx(db, async () => {
    // Get the failed job
    const failedJob = await getJob(db, failedJobId);
    if (!failedJob) {
      throw new Error(`Job ${failedJobId} not found`);
    }

    // Validate job status
    if (failedJob.status !== JobStatus.FAILED) {
      throw new Error(`Job ${failedJobId} is not in failed status, cannot retry. Current status: ${failedJob.status}`);
    }

    // Get all items from the failed job
    const failedItems = await listJobItems(db, failedJobId, 10000);

    // Parse original job options
    const originalOptions: JobOptions = safeJsonParse<JobOptions>(failedJob.options_json, {
      rootPath: failedJob.root_path,
      outputMode: failedJob.output_mode,
      conflictPolicy: failedJob.conflict_policy,
      zipSlipPolicy: 'block'
    });

    // Build new job options: reuse original options but replace password fields
    const newJobOptions: JobOptions = {
      rootPath: originalOptions.rootPath || failedJob.root_path,
      outputMode: originalOptions.outputMode || failedJob.output_mode,
      conflictPolicy: originalOptions.conflictPolicy || failedJob.conflict_policy,
      zipSlipPolicy: originalOptions.zipSlipPolicy || 'block',
      overwriteMode: originalOptions.overwriteMode
    };

    // Add password options (replace original password options)
    newJobOptions.passwordMode = passwordOptions.passwordMode;
    if (passwordOptions.passwordMode === 'manual' && passwordOptions.passwordValue) {
      // For manual password: store a marker instead of plain text
      // The actual password will be passed to worker via options, but we mark it as manual
      newJobOptions.passwordMode = 'manual';
      // Note: passwordValue is stored in options_json for worker to use, but we'll mark it
      // In a production system, you might want to encrypt this or use a different storage mechanism
      newJobOptions.passwordValue = passwordOptions.passwordValue;
    } else if (passwordOptions.passwordMode === 'select' && passwordOptions.passwordRefIndex !== undefined) {
      newJobOptions.passwordMode = 'select';
      newJobOptions.passwordRefIndex = passwordOptions.passwordRefIndex;
    } else if (passwordOptions.passwordMode === 'try_list') {
      newJobOptions.passwordMode = 'try_list';
      newJobOptions.passwordTryOrder = 'as_is';
    }

    // Build job items from failed job items
    const jobItems = failedItems.map(item => ({
      archivePath: item.archive_path,
      ext: item.ext,
      outDir: item.out_dir || (() => {
        // Calculate outDir if not set
        const dir = path.dirname(item.archive_path);
        const basename = path.basename(item.archive_path, path.extname(item.archive_path));
        return path.join(dir, basename);
      })(),
      archiveGroupJson: item.archive_group_json ? safeJsonParse(item.archive_group_json, undefined) : undefined
    }));

    // Create new job
    const createOptions: CreateJobOptions = {
      rootPath: newJobOptions.rootPath!,
      outputMode: newJobOptions.outputMode!,
      conflictPolicy: newJobOptions.conflictPolicy!,
      options: newJobOptions,
      retryFromJobId: failedJobId,
      items: jobItems
    };

    const newJobId = await createJob(db, createOptions);
    return newJobId;
  });
}

/**
 * Clear all failed jobs (batch delete)
 * Deletes jobs with status = 'failed' and all associated job_items
 * Returns the number of deleted jobs
 */
export async function clearFailedJobs(
  db: sqlite3.Database
): Promise<number> {
  return runInTx(db, async () => {
    // Count failed jobs before deletion
    const countResult = await dbGet<{ count: number }>(
      db,
      'SELECT COUNT(*) as count FROM jobs WHERE status = ?',
      [JobStatus.FAILED]
    );
    
    const count = countResult?.count || 0;
    
    if (count === 0) {
      return 0;
    }

    // Delete failed jobs (job_items will be deleted automatically via CASCADE)
    await dbRun(db, 'DELETE FROM jobs WHERE status = ?', [JobStatus.FAILED]);
    
    return count;
  });
}