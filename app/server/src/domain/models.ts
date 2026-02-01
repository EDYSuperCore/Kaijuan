import { JobStatus, ItemStatus, FailedReason } from './states';

/**
 * Output Mode
 */
export type OutputMode = 'sibling_named_dir' | 'in_place' | 'custom';

/**
 * Conflict Policy
 */
export type ConflictPolicy = 'skip' | 'rename' | 'overwrite';

/**
 * Job Row (matches DB schema - snake_case in DB, camelCase in TS)
 */
export interface JobRow {
  id: number;
  status: JobStatus;
  root_path: string;
  output_mode: OutputMode;
  output_dir: string | null;
  conflict_policy: ConflictPolicy;
  concurrency: number;
  options_json: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  canceled: number;
  last_error: string | null;
  log_path: string | null;
  retry_from_job_id?: number | null; // ID of the original failed job this retry is based on
}

/**
 * Job Item Row (matches DB schema - snake_case in DB, camelCase in TS)
 */
export interface JobItemRow {
  id: number;
  job_id: number;
  archive_path: string;
  archive_group_json: string | null;
  ext: string;
  out_dir: string | null;
  status: ItemStatus;
  attempt: number;
  failed_reason: FailedReason | null;
  failed_detail: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

/**
 * Password Mode
 */
export type PasswordMode = 'none' | 'select' | 'manual' | 'try_list';

/**
 * Job Options (stored in options_json)
 */
export interface JobOptions {
  rootPath?: string;
  outputMode?: OutputMode;
  outputDir?: string;
  overwriteMode?: 'aoa' | 'aos' | 'aou' | 'aot'; // 7z native overwrite mode parameter
  conflictPolicy?: ConflictPolicy; // Legacy field (deprecated)
  conflict?: ConflictPolicy; // Legacy field (deprecated)
  zipSlipPolicy?: 'block' | 'allow';
  passwordCandidates?: string[]; // Legacy field (deprecated)
  passwordMode?: PasswordMode;
  passwordValue?: string; // When passwordMode="manual"
  passwordRefIndex?: number; // When passwordMode="select"
  passwordTryOrder?: 'as_is'; // Reserved, currently only supports as_is
  [key: string]: any;
}

/**
 * Create Job Options
 */
export interface CreateJobOptions {
  rootPath: string;
  outputMode: OutputMode;
  outputDir?: string;
  conflictPolicy: ConflictPolicy;
  concurrency?: number;
  options?: JobOptions;
  retryFromJobId?: number | null; // ID of the original failed job this retry is based on
  items: Array<{
    archivePath: string;
    ext: string;
    outDir: string;
    archiveGroupJson?: any;
  }>;
}

/**
 * Scan Options
 */
export interface ScanOptions {
  rootPath: string;
  recursive?: boolean;
  exts?: string[];
  ignoreDirs?: string[];
  maxItems?: number;
}

/**
 * Job Counts
 */
export interface JobCounts {
  success: number;
  failed: number;
  skipped: number;
  canceled: number;
}

/**
 * Settings
 */
export interface Settings {
  conflict: ConflictPolicy;
  outputMode: OutputMode;
  zipSlipPolicy: 'block' | 'allow';
  commonPasswords?: string[]; // Common passwords list, can be empty
  passwordMasking?: boolean; // Whether to mask passwords in UI (default true)
  updatedAt: number;
}

/**
 * Default Settings
 */
export const DEFAULT_SETTINGS: Settings = {
  conflict: 'skip',
  outputMode: 'sibling_named_dir',
  zipSlipPolicy: 'block',
  commonPasswords: [],
  passwordMasking: true,
  updatedAt: 0
};