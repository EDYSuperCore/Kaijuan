import * as sqlite3 from 'sqlite3';
import { JobStatus, ItemStatus, FailedReason } from '../domain/states';
import { dbRun, dbAll } from '../infra/db';
import { now } from '../utils/time';

/**
 * Reconcile on boot: reset interrupted jobs and items
 */
export async function reconcileOnBoot(db: sqlite3.Database): Promise<void> {
  // Reset interrupted jobs to queued
  await dbRun(db, `
    UPDATE jobs
    SET status = ?, last_error = ?
    WHERE status IN (?, ?, ?)
  `, [
    JobStatus.QUEUED,
    'interrupted, re-queued',
    JobStatus.RUNNING,
    JobStatus.PAUSING,
    JobStatus.CANCELING
  ]);

  // Mark running items as failed (interrupted)
  await dbRun(db, `
    UPDATE job_items
    SET status = ?, failed_reason = ?, failed_detail = ?, ended_at = ?
    WHERE status = ?
  `, [
    ItemStatus.FAILED,
    FailedReason.INTERRUPTED,
    'interrupted by restart',
    now(),
    ItemStatus.RUNNING
  ]);

  // Update job counts for interrupted items
  const interruptedJobs = await dbAll<{ job_id: number; count: number }>(db, `
    SELECT job_id, COUNT(*) as count
    FROM job_items
    WHERE failed_reason = ? AND ended_at > ?
    GROUP BY job_id
  `, [FailedReason.INTERRUPTED, now() - 60000]); // last minute

  for (const row of interruptedJobs) {
    await dbRun(db, `
      UPDATE jobs SET failed = failed + ? WHERE id = ?
    `, [row.count, row.job_id]);
  }
}
