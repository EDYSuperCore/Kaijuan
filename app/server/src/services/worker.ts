import * as sqlite3 from 'sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
// Debug infrastructure removed
import { JobStatus, ItemStatus, FailedReason } from '../domain/states';
import { JobRow, JobItemRow, JobOptions, ConflictPolicy } from '../domain/models';
import {
  casJobQueuedToRunning,
  getNextQueuedJob,
  getPendingItems,
  updateJobStatus,
  updateItemToRunning,
  finalizeItem,
  cancelRemainingItems,
  getJob,
  listJobItems
} from './jobService';
import { dbRun, dbGet, dbAll, getVarDir, getDb } from '../infra/db';
import { FileLogger } from '../utils/fileLogger';
import { resolve7zPath } from '../infra/7z-resolver';
import { getSettings } from './settingsService';
import { build7zArgs, ConflictPolicy as OverwriteMode, OverwriteModeSuffix } from '../worker/7z-args';
import {
  is7zTraceEnabled,
  traceLog,
  traceStdout,
  traceStderr,
  resolveRealPath,
  sampleDirectory,
  writeTraceFile
} from '../utils/7z-trace';
import {
  resolvePasswordAttempts,
  isPasswordError
} from '../utils/password-resolver';
import { safeJsonParse } from '../utils/json-utils';

let workerRunning = false;
let workerInterval: NodeJS.Timeout | null = null;

// Debug infrastructure removed

// 7z args builder imported from worker/7z-args.ts

/**
 * Process a single job
 */
async function processJob(db: sqlite3.Database): Promise<void> {
  // Get next queued job
  const job = await getNextQueuedJob(db);
  if (!job) {
    return; // No job to process
  }

  // CAS: queued -> running
  const acquired = await casJobQueuedToRunning(db, job.id);
  if (!acquired) {
    return; // Job was taken by another worker or status changed
  }

  const logPath = job.log_path || path.join(getVarDir(), 'logs', `job-${job.id}.log`);
  const logStream = new FileLogger(logPath);

  try {
    logStream.write(`=== Job ${job.id} started at ${new Date(job.started_at || Date.now()).toISOString()}\n`);

    // Resolve 7z path once at job start
    let sevenZip: string;
    try {
      sevenZip = await resolve7zPath();
    } catch (err: any) {
      const errorMsg = err.message || '7z not found';
      logStream.write(`ERROR: ${errorMsg}\n`);
      logStream.end();

      // Mark ALL items (including pending ones) as failed
      const allItems = await dbAll<JobItemRow>(
        db,
        'SELECT * FROM job_items WHERE job_id = ?',
        [job.id]
      );

      // Update all items to failed (including pending and running ones)
      for (const item of allItems) {
        if (item.status === ItemStatus.PENDING || item.status === ItemStatus.RUNNING) {
          await finalizeItem(
            db,
            job.id,
            item.id,
            ItemStatus.FAILED,
            FailedReason.TOOL_MISSING,
            errorMsg
          );
        }
      }

      // Update job: set failed count to total, ensure all counts are correct
      await dbRun(
        db,
        'UPDATE jobs SET status = ?, ended_at = ?, failed = ?, success = 0, skipped = 0, canceled = 0 WHERE id = ?',
        [JobStatus.FAILED, Date.now(), job.total, job.id]
      );

      return;
    }

    // Log 7z path being used
    console.log(`[KaijuanWorker] Using 7z: ${sevenZip}`);
    logStream.write(`[KaijuanWorker] Using 7z: ${sevenZip}\n`);

    // Get pending items
    let items = await getPendingItems(db, job.id);

    // Parse JobOptions from options_json (source of truth)
    const options: JobOptions = safeJsonParse<JobOptions>(job.options_json, {
      rootPath: job.root_path,
      outputMode: job.output_mode,
      conflictPolicy: job.conflict_policy,
      zipSlipPolicy: 'block'
    });
    
    // Resolve zipSlipPolicy: from options, default to 'block'
    const zipSlipPolicy: 'block' | 'allow' = options.zipSlipPolicy || 'block';

    // Log job options
    // Resolve overwriteMode: use provided value or convert from conflictPolicy
    // Note: 7z-args.ts will automatically add '-ao' prefix, so we only need the suffix letter
    let overwriteModeForLog: string = options.overwriteMode || 'none';
    if (!options.overwriteMode && options.conflictPolicy) {
      const conflictPolicyToOverwriteMode: Record<ConflictPolicy, 's' | 'a' | 'u'> = {
        'skip': 's',
        'overwrite': 'a',
        'rename': 'u'
      };
      const suffix = conflictPolicyToOverwriteMode[options.conflictPolicy];
      // Convert to full format for logging display
      overwriteModeForLog = suffix.length === 1 ? `ao${suffix}` : suffix;
    }
    const logMsg = `[KaijuanJob] jobId=${job.id} overwriteMode=${overwriteModeForLog} conflictPolicy=${options.conflictPolicy || 'none'} zipSlipPolicy=${zipSlipPolicy} outputMode=${options.outputMode || 'sibling_named_dir'}`;
    console.log(logMsg);
    logStream.write(`${logMsg}\n`);

    // Process items
    // writeDiagnosticReport removed - no longer using Node report

    // Process each item
    while (items.length > 0) {
      // Check job status
      const currentJob = await getJob(db, job.id);
      if (!currentJob) {
        break;
      }

      if (currentJob.status === JobStatus.PAUSING) {
        // Stop dispatching, wait for current item to finish, then job -> paused
        await updateJobStatus(db, job.id, JobStatus.PAUSING, JobStatus.PAUSED);
        logStream.write(`Job ${job.id} paused\n`);
        break;
      }

      if (currentJob.status === JobStatus.CANCELING) {
        // Stop dispatching, cancel remaining items, job -> canceled
        const canceledCount = await cancelRemainingItems(db, job.id);
        logStream.write(`Job ${job.id} canceled ${canceledCount} remaining items\n`);
        await updateJobStatus(db, job.id, JobStatus.CANCELING, JobStatus.CANCELED);
        logStream.write(`Job ${job.id} canceled\n`);
        break;
      }

      // Process first pending item
      const item = items[0];
      await processItem(db, item, currentJob, logStream, sevenZip, zipSlipPolicy);

      // Refresh items list
      items = await getPendingItems(db, job.id);
    }

    // Finalize job: recalculate counts and set status
    await finalizeJob(db, job.id, logStream);

  } catch (error: any) {
    // Enhanced error logging: output name, message, and full stack
    logStream.write(`Job ${job.id} error: ${error.name || 'Error'}\n`);
    logStream.write(`Job ${job.id} error message: ${error.message || '(no message)'}\n`);
    logStream.write(`Job ${job.id} error stack:\n${error.stack || '(no stack)'}\n`);
    
    // Additional diagnostic for ReferenceError
    if (error.name === 'ReferenceError') {
      logStream.write(`[Diag] ReferenceError captured\n`);
    }
    
    // Also output to console for immediate visibility
    console.error(`[Worker] Job ${job.id} error:`, {
      name: error.name || 'Error',
      message: error.message || '(no message)',
      stack: error.stack || '(no stack)',
      isReferenceError: error.name === 'ReferenceError'
    });
    
    if (error.name === 'ReferenceError') {
      console.error(`[Diag] ReferenceError captured`);
    }
    
    await updateJobStatus(db, job.id, JobStatus.RUNNING, JobStatus.FAILED);
  } finally {
    logStream.end();
  }
}

/**
 * Process a single item
 * Only calls 7z with whitelisted parameters, no custom file handling
 */
async function processItem(
  db: sqlite3.Database,
  item: JobItemRow,
  job: JobRow,
  logStream: FileLogger,
  sevenZip: string,
  zipSlipPolicy: 'block' | 'allow'
): Promise<void> {
  // Update item: pending -> running
  await updateItemToRunning(db, item.id);

  logStream.write(`\n--- Processing: ${item.archive_path}\n`);

  try {
    // Calculate output directory (sibling directory, remove extension)
    const dir = path.dirname(item.archive_path);
    const basename = path.basename(item.archive_path, path.extname(item.archive_path));
    const outDir = path.join(dir, basename);

    logStream.write(`[Extract] outDir: ${outDir}\n`);

    // Get overwriteMode and password settings from job options
    const options: JobOptions = safeJsonParse<JobOptions>(job.options_json, {
      rootPath: job.root_path,
      outputMode: job.output_mode,
      conflictPolicy: job.conflict_policy,
      zipSlipPolicy: 'block'
    });
    
    // Convert conflictPolicy (or legacy conflict) to overwriteMode if overwriteMode is not provided
    // Note: 7z-args.ts will automatically add '-ao' prefix, so we only need the suffix letter
    // Mapping: skip -> 's' (becomes -aos), overwrite -> 'a' (becomes -aoa), rename -> 'u' (becomes -aou)
    let overwriteMode: OverwriteMode | OverwriteModeSuffix | undefined = options.overwriteMode;
    
    // Debug log: show what we have in options
    logStream.write(`[Extract] DEBUG: options.overwriteMode=${options.overwriteMode || 'undefined'}, options.conflictPolicy=${options.conflictPolicy || 'undefined'}, options.conflict=${(options as any).conflict || 'undefined'}\n`);
    
    if (!overwriteMode) {
      // Try conflictPolicy first, then fallback to legacy conflict field
      const conflictPolicyValue = options.conflictPolicy || (options as any).conflict;
      
      if (conflictPolicyValue) {
        const conflictPolicyToOverwriteMode: Record<ConflictPolicy, 's' | 'a' | 'u'> = {
          'skip': 's',
          'overwrite': 'a',
          'rename': 'u'
        };
        
        // Type guard: ensure conflictPolicyValue is a valid ConflictPolicy
        const conflictPolicy = conflictPolicyValue as ConflictPolicy;
        if (conflictPolicy in conflictPolicyToOverwriteMode) {
          const suffix = conflictPolicyToOverwriteMode[conflictPolicy];
          // Pass single letter suffix to 7z-args.ts (it will add -ao prefix)
          overwriteMode = suffix;
          logStream.write(`[Extract] Converted conflictPolicy=${conflictPolicy} to overwriteMode suffix=${suffix} (will become -ao${suffix})\n`);
        } else {
          logStream.write(`[Extract] WARNING: Invalid conflictPolicy value: ${conflictPolicyValue}, defaulting to 's' (skip)\n`);
          overwriteMode = 's'; // Default fallback (becomes -aos)
        }
      } else {
        // No conflictPolicy provided, default to skip ('s' suffix, becomes -aos)
        overwriteMode = 's';
        logStream.write(`[Extract] No overwriteMode or conflictPolicy found, defaulting to 's' (skip, will become -aos)\n`);
      }
    } else {
      // If overwriteMode is provided in full format (e.g., 'aos'), extract suffix
      if (overwriteMode && overwriteMode.length > 1 && typeof overwriteMode === 'string' && overwriteMode.startsWith('ao')) {
        overwriteMode = overwriteMode.substring(2) as OverwriteModeSuffix;
      }
      logStream.write(`[Extract] Using provided overwriteMode=${overwriteMode} (will become -ao${overwriteMode})\n`);
    }
    
    // Final debug log: show what will be used
    logStream.write(`[Extract] DEBUG: Final overwriteMode suffix=${overwriteMode || 'undefined'} (will be passed to 7z as -ao${overwriteMode || 'undefined'})\n`);

    // Get settings for common passwords
    const settings = await getSettings(db);
    const commonPasswords = settings?.commonPasswords || [];

    // Resolve password attempts
    let passwordAttempts: string[] = [];
    let usedPasswordIndex: number | string | undefined = undefined;
    try {
      passwordAttempts = resolvePasswordAttempts(options, commonPasswords);
      
      // Determine usedPasswordIndex for logging
      if (options.passwordMode === 'select' && options.passwordRefIndex !== undefined) {
        usedPasswordIndex = options.passwordRefIndex;
      } else if (options.passwordMode === 'try_list') {
        // Will be set after successful attempt
      } else if (options.passwordMode === 'manual') {
        usedPasswordIndex = 'manual';
      }
    } catch (err: any) {
      const errorMsg = `Failed to resolve password attempts: ${err.message}`;
      logStream.write(`[Extract] ERROR: ${errorMsg}\n`);
      await finalizeItem(
        db,
        job.id,
        item.id,
        ItemStatus.FAILED,
        FailedReason.UNKNOWN,
        errorMsg
      );
      return;
    }

    // Log password mode (without revealing password value)
    const passwordModeLog = options.passwordMode || 'none';
    if (passwordModeLog === 'manual') {
      logStream.write(`[Extract] passwordMode=manual (password provided, not logged)\n`);
    } else {
      logStream.write(`[Extract] passwordMode=${passwordModeLog} attempts=${passwordAttempts.length}\n`);
    }

    // 7z trace: Sample files before extraction
    if (is7zTraceEnabled()) {
      const beforeSamples = sampleDirectory(outDir, 50);
      const beforeData = {
        jobId: job.id,
        itemId: item.id,
        timestamp: new Date().toISOString(),
        outputDir: resolveRealPath(outDir),
        archivePath: resolveRealPath(item.archive_path),
        samples: beforeSamples
      };
      const beforePath = writeTraceFile(job.id, 'before', beforeData);
      traceLog(`File samples before extraction written to: ${beforePath}`, logStream);
    }

    // 7z trace: Print execution command evidence
    const resolvedBin = resolveRealPath(sevenZip);
    const resolvedArchive = resolveRealPath(item.archive_path);
    const resolvedOutDir = resolveRealPath(outDir);
    const cwd = process.cwd();

    traceLog(`bin=${resolvedBin}`, logStream);
    traceLog(`cwd=${cwd}`, logStream);
    traceLog(`outputDir=${resolvedOutDir}`, logStream);
    traceLog(`archivePath=${resolvedArchive}`, logStream);

    // Try passwords in sequence (or no password if attempts is empty)
    let extractSuccess = false;
    let extractError: string | null = null;
    let attemptsCount = 0;
    let passwordResult: 'not_needed' | 'success' | 'wrong_password' | 'failed_other' = 'not_needed';
    let shouldStopDueToError = false; // Flag to track if we should stop due to non-password error

    // If no password attempts, try once without password
    if (passwordAttempts.length === 0) {
      passwordAttempts = [''];
    }

    for (let attemptIndex = 0; attemptIndex < passwordAttempts.length; attemptIndex++) {
      const password = passwordAttempts[attemptIndex];
      attemptsCount++;

      // Build 7z arguments with password
      let spawnArgs: string[];
      try {
        spawnArgs = build7zArgs({
          archivePath: item.archive_path,
          outDir: outDir,
          overwriteMode: overwriteMode,
          yes: true,
          password: password || undefined // Empty string means no password
        });
        
        // Log password attempt (without revealing password)
        if (passwordAttempts.length > 1) {
          logStream.write(`[Extract] Attempt ${attemptIndex + 1}/${passwordAttempts.length}${password ? ' (with password)' : ' (no password)'}\n`);
        }
        logStream.write(`[Extract] 7z args: ${spawnArgs.join(' ').replace(/-p[^\s]+/g, '-p***')}\n`);
        
        // Print argv items one by one
        spawnArgs.forEach((arg: string, index: number) => {
          traceLog(`argv[${index}]=${arg}`, logStream);
        });
      } catch (err: any) {
        const errorMsg = `Failed to build 7z args: ${err.message}`;
        logStream.write(`[Extract] ERROR: ${errorMsg}\n`);
        extractError = errorMsg;
        passwordResult = 'failed_other';
        shouldStopDueToError = true;
        break;
      }

      // Execute 7z
      const attemptSuccess = await new Promise<boolean>((resolve) => {
        const proc = spawn(sevenZip, spawnArgs, {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
          const text = data.toString();
          stdout += text;
          logStream.write(text);
          
          // 7z trace: Print stdout line by line
          if (is7zTraceEnabled()) {
            const lines = text.split('\n').filter((line: string) => line.trim() !== '');
            lines.forEach((line: string) => {
              traceStdout(line, logStream);
            });
          }
        });

        proc.stderr.on('data', (data) => {
          const text = data.toString();
          stderr += text;
          logStream.write(text);
          
          // 7z trace: Print stderr line by line
          if (is7zTraceEnabled()) {
            const lines = text.split('\n').filter((line: string) => line.trim() !== '');
            lines.forEach((line: string) => {
              traceStderr(line, logStream);
            });
          }
        });

        proc.on('close', (code, signal) => {
          // 7z trace: Print exit code
          if (is7zTraceEnabled()) {
            traceLog(`exit code=${code} signal=${signal || 'null'}`, logStream);
          }
          
          if (code === 0) {
            // Success
            resolve(true);
          } else {
            // Check if it's a password error
            const isPwdError = isPasswordError(stdout, stderr);
            if (isPwdError) {
              logStream.write(`[Extract] Attempt ${attemptIndex + 1} failed: wrong password\n`);
              resolve(false); // Continue to next attempt
            } else {
              // Non-password error, stop trying
              extractError = `7z exited with code ${code}${stderr ? ': ' + stderr.trim().substring(0, 200) : ''}`;
              logStream.write(`[Extract] ERROR: ${extractError}\n`);
              passwordResult = 'failed_other';
              shouldStopDueToError = true;
              resolve(false); // Stop trying
            }
          }
        });

        proc.on('error', (err) => {
          extractError = `Failed to spawn 7z: ${err.message}`;
          logStream.write(`[Extract] ERROR: ${extractError}\n`);
          passwordResult = 'failed_other';
          shouldStopDueToError = true;
          resolve(false); // Stop trying
        });
      });

      // Check if we should stop due to non-password error (before checking attemptSuccess)
      if (shouldStopDueToError) {
        // Non-password error, already stopped
        break;
      }

      if (attemptSuccess) {
        extractSuccess = true;
        if (password) {
          passwordResult = 'success';
          // Record which password was used
          if (options.passwordMode === 'try_list') {
            usedPasswordIndex = attemptIndex;
          }
        } else {
          passwordResult = 'not_needed';
        }
        logStream.write(`[Extract] Successfully extracted${password ? ' (with password)' : ''}\n`);
        break; // Success, stop trying
      }
      // Otherwise, continue to next password attempt
    }

    // If all attempts failed and last error was password-related
    if (!extractSuccess && passwordAttempts.length > 0 && passwordResult !== 'failed_other') {
      passwordResult = 'wrong_password';
      extractError = `All password attempts failed (tried ${attemptsCount} password(s))`;
      logStream.write(`[Extract] ERROR: ${extractError}\n`);
    }

    // 7z trace: Sample files after extraction
    if (is7zTraceEnabled()) {
      const afterSamples = sampleDirectory(outDir, 50);
      const afterData = {
        jobId: job.id,
        itemId: item.id,
        timestamp: new Date().toISOString(),
        outputDir: resolveRealPath(outDir),
        archivePath: resolveRealPath(item.archive_path),
        extractSuccess: extractSuccess,
        samples: afterSamples
      };
      const afterPath = writeTraceFile(job.id, 'after', afterData);
      traceLog(`File samples after extraction written to: ${afterPath}`, logStream);
    }

    // Log password result
    if (passwordAttempts.length > 0) {
      const pwdInfo = `[pwd] mode=${options.passwordMode || 'none'} attempts=${attemptsCount} result=${passwordResult}`;
      if (usedPasswordIndex !== undefined) {
        logStream.write(`${pwdInfo} usedIndex=${usedPasswordIndex}\n`);
      } else {
        logStream.write(`${pwdInfo}\n`);
      }
    }

    // Finalize item based on extraction result
    if (extractSuccess) {
      logStream.write(`[Success] Item ${item.id} completed: ${outDir}\n`);
      await finalizeItem(
        db,
        job.id,
        item.id,
        ItemStatus.SUCCESS,
        undefined,
        'Extracted successfully'
      );
      // Update outDir in item
      await dbRun(
        db,
        'UPDATE job_items SET out_dir = ? WHERE id = ?',
        [outDir, item.id]
      );
    } else {
      await finalizeItem(
        db,
        job.id,
        item.id,
        ItemStatus.FAILED,
        FailedReason.UNKNOWN,
        `extract: ${extractError}`
      );
    }

  } catch (err: any) {
    logStream.write(`ERROR: ${err.message}\n`);
    await finalizeItem(
      db,
      job.id,
      item.id,
      ItemStatus.FAILED,
      FailedReason.UNKNOWN,
      err.message
    );
  }
}

/**
 * Finalize job: recalculate counts and set status
 */
async function finalizeJob(db: sqlite3.Database, jobId: number, logStream: FileLogger): Promise<void> {
  logStream.write(`\n=== Job ${jobId} processing completed\n`);

  // Recalculate counts from items table (source of truth)
  const allItems = await dbAll<JobItemRow>(
    db,
    'SELECT * FROM job_items WHERE job_id = ?',
    [jobId]
  );

  // Force converge any pending/running items to failed
  const unconvergedItems = allItems.filter(
    item => item.status === ItemStatus.PENDING || item.status === ItemStatus.RUNNING
  );
  if (unconvergedItems.length > 0) {
    console.warn(`[JobFinalize] WARNING: Job ${jobId} has ${unconvergedItems.length} unconverged items, forcing to failed`);
    for (const item of unconvergedItems) {
      await finalizeItem(
        db,
        jobId,
        item.id,
        ItemStatus.FAILED,
        FailedReason.INTERRUPTED,
        'Job ended but item was not finalized; force failed for consistency.'
      );
    }
  }

  // Recalculate counts from items (after convergence)
  const finalItems = await dbAll<JobItemRow>(
    db,
    'SELECT * FROM job_items WHERE job_id = ?',
    [jobId]
  );

  const total = finalItems.length;
  const finalSuccess = finalItems.filter(item => item.status === ItemStatus.SUCCESS).length;
  const finalFailed = finalItems.filter(item => item.status === ItemStatus.FAILED).length;
  const finalSkipped = finalItems.filter(item => item.status === ItemStatus.SKIPPED).length;
  const finalCanceled = finalItems.filter(item => item.status === ItemStatus.CANCELED).length;

  // Calculate done count
  const done = finalSuccess + finalFailed + finalSkipped + finalCanceled;

  // Determine job status based on counts
  // Rule: failed > 0 => failed, else if done == total => success (even if success=0 and skipped=total)
  let jobStatus: JobStatus;
  if (finalCanceled === total) {
    jobStatus = JobStatus.CANCELED;
  } else if (finalFailed > 0) {
    // Only mark as failed if there are actual failures
    jobStatus = JobStatus.FAILED;
  } else if (done === total) {
    // All items are done (success, skipped, or canceled), and no failures
    // This includes the case: success=0, skipped=total, failed=0 => status=success
    jobStatus = JobStatus.COMPLETED;
  } else {
    // Still processing (done < total)
    jobStatus = JobStatus.RUNNING;
    console.warn(
      `[JobFinalize] WARNING: Job ${jobId} not fully done: total=${total}, done=${done}, success=${finalSuccess}, failed=${finalFailed}, skipped=${finalSkipped}, canceled=${finalCanceled}`
    );
  }

  // Update job with correct counts and status
  const endedAt = Date.now();
  await dbRun(
    db,
    'UPDATE jobs SET status = ?, ended_at = ?, success = ?, failed = ?, skipped = ?, canceled = ? WHERE id = ?',
    [jobStatus, endedAt, finalSuccess, finalFailed, finalSkipped, finalCanceled, jobId]
  );

  console.log(
    `[JobFinalize] Job ${jobId} finalized: status=${jobStatus}, total=${total}, success=${finalSuccess}, failed=${finalFailed}, skipped=${finalSkipped}, canceled=${finalCanceled}`
  );
  
  // NOTE: job finalization does NOT close server or exit process
  // Worker loop continues to wait for next job
}

/**
 * Worker loop
 */
async function workerLoop(): Promise<void> {
  if (workerRunning) {
    return; // Already running
  }

  workerRunning = true;

  try {
    const db = getDb();
    await processJob(db);
  } catch (error: any) {
    console.error('Worker error:', error);
  } finally {
    workerRunning = false;
  }
}

/**
 * Start worker loop
 */
export function startWorkerLoop(): void {
  if (workerInterval) {
    return; // Already started
  }

  // Run immediately
  workerLoop();

  // Then run every 1 second
  workerInterval = setInterval(() => {
    workerLoop();
  }, 1000);
}

/**
 * Stop worker loop
 */
export function stopWorkerLoop(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  workerRunning = false;
}
