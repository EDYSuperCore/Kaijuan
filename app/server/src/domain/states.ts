/**
 * Job Status Enum
 */
export enum JobStatus {
  DRAFT = 'draft',
  QUEUED = 'queued',
  RUNNING = 'running',
  PAUSING = 'pausing',
  PAUSED = 'paused',
  CANCELING = 'canceling',
  CANCELED = 'canceled',
  COMPLETED = 'completed',
  FAILED = 'failed'
}

/**
 * Item Status Enum
 */
export enum ItemStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  SUCCESS = 'success',
  FAILED = 'failed',
  SKIPPED = 'skipped',
  CANCELED = 'canceled'
}

/**
 * Failed Reason Enum
 */
export enum FailedReason {
  TOOL_MISSING = 'tool_missing',
  PASSWORD_REQUIRED = 'password_required',
  PASSWORD_WRONG = 'password_wrong',
  CORRUPTED = 'corrupted',
  VOLUME_MISSING = 'volume_missing',
  PERMISSION_DENIED = 'permission_denied',
  DISK_FULL = 'disk_full',
  PATH_TRAVERSAL_BLOCKED = 'path_traversal_blocked',
  INTERRUPTED = 'interrupted',
  UNKNOWN = 'unknown'
}
