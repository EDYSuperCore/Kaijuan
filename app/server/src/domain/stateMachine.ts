import { JobStatus, ItemStatus } from './states';

/**
 * Job Status Transitions
 */
export const jobTransitions: Record<JobStatus, JobStatus[]> = {
  [JobStatus.DRAFT]: [JobStatus.QUEUED],
  [JobStatus.QUEUED]: [JobStatus.RUNNING, JobStatus.CANCELING],
  [JobStatus.RUNNING]: [JobStatus.PAUSING, JobStatus.CANCELING, JobStatus.COMPLETED, JobStatus.FAILED],
  [JobStatus.PAUSING]: [JobStatus.PAUSED],
  [JobStatus.PAUSED]: [JobStatus.QUEUED, JobStatus.CANCELING],
  [JobStatus.CANCELING]: [JobStatus.CANCELED],
  [JobStatus.CANCELED]: [],
  [JobStatus.COMPLETED]: [],
  [JobStatus.FAILED]: []
};

/**
 * Item Status Transitions
 */
export const itemTransitions: Record<ItemStatus, ItemStatus[]> = {
  [ItemStatus.PENDING]: [ItemStatus.RUNNING, ItemStatus.CANCELED],
  [ItemStatus.RUNNING]: [ItemStatus.SUCCESS, ItemStatus.FAILED, ItemStatus.SKIPPED, ItemStatus.CANCELED],
  [ItemStatus.SUCCESS]: [],
  [ItemStatus.FAILED]: [ItemStatus.PENDING], // retry
  [ItemStatus.SKIPPED]: [],
  [ItemStatus.CANCELED]: []
};

/**
 * Assert job status transition is valid
 */
export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  const allowed = jobTransitions[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(`Invalid job transition: ${from} -> ${to}`);
  }
}

/**
 * Assert item status transition is valid
 */
export function assertItemTransition(from: ItemStatus, to: ItemStatus): void {
  const allowed = itemTransitions[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(`Invalid item transition: ${from} -> ${to}`);
  }
}

/**
 * Check if job status is terminal
 */
export function isJobTerminal(status: JobStatus): boolean {
  return [
    JobStatus.COMPLETED,
    JobStatus.FAILED,
    JobStatus.CANCELED
  ].includes(status);
}

/**
 * Check if item status is terminal
 */
export function isItemTerminal(status: ItemStatus): boolean {
  return [
    ItemStatus.SUCCESS,
    ItemStatus.FAILED,
    ItemStatus.SKIPPED,
    ItemStatus.CANCELED
  ].includes(status);
}

/**
 * Compute job progress
 */
export function computeJobProgress(params: {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  canceled: number;
}): { done: number; progressRatio: number } {
  const { total, success, failed, skipped, canceled } = params;
  const done = success + failed + skipped + canceled;
  const progressRatio = total > 0 ? done / total : 0;
  return { done, progressRatio };
}
