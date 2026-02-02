// Minimal error handlers (only console.error, no file logging)
process.on("uncaughtException", (err) => {
  console.error(err.stack || err);
});
process.on("unhandledRejection", (r) => {
  console.error(r instanceof Error ? r.stack : r);
});

import fastify from 'fastify';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { openDb, getVarDir, ensureDir, getDb } from './infra/db';
import { migrate } from './infra/migrations';
import { reconcileOnBoot } from './services/reconcile';
import { startWorkerLoop } from './services/worker';
import {
  createJob,
  enqueueJob,
  requestPause,
  requestCancel,
  retryItem,
  listJobs,
  getJob,
  listJobItems,
  deleteJob,
  clearFailedJobs,
  retryJob
} from './services/jobService';
import { CreateJobOptions, DEFAULT_SETTINGS, ConflictPolicy, JobOptions, OutputMode } from './domain/models';
import { resolve7zPath } from './infra/7z-resolver';
import { getSettings, updateSettings } from './services/settingsService';

const app = fastify({ logger: true });

// Initialize database
const varDir = getVarDir();
ensureDir(varDir);
ensureDir(path.join(varDir, 'data'));
ensureDir(path.join(varDir, 'logs'));

const db = openDb();



// API routes (register before static file service to ensure priority)
app.get('/api/health', async (request, reply) => {
  return {
    ok: true,
    version: '1.2.0',
    pid: process.pid
  };
});

app.get('/api/test', async (request, reply) => {
  return {
    timestamp: Date.now(),
    iso: new Date().toISOString(),
    local: new Date().toString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
});

app.get('/api/diag', async (request, reply) => {
  try {
    const sevenZipPath = await resolve7zPath();
    return {
      sevenZip: {
        path: sevenZipPath,
        bundled: sevenZipPath.includes('vendor/7zip')
      }
    };
  } catch (err: any) {
    return {
      sevenZip: {
        path: null,
        error: err.message
      }
    };
  }
});

app.get('/api/settings', async (request, reply) => {
  try {
    const settings = await getSettings(db);
    // Return null if not found - do not return default settings
    // Frontend must handle missing settings and prompt user to configure
    return settings;
  } catch (err: any) {
    reply.code(500);
    return { error: err.message };
  }
});

app.put('/api/settings', async (request: any, reply) => {
  try {
    const { conflict, outputMode, zipSlipPolicy, commonPasswords, passwordMasking } = request.body;

    // Log request with password masking (for debugging, no full passwords)
    const logBody: any = {
      conflict,
      outputMode,
      zipSlipPolicy,
      passwordMasking
    };
    if (commonPasswords && Array.isArray(commonPasswords)) {
      logBody.commonPasswordsCount = commonPasswords.length;
      logBody.commonPasswordsPreview = commonPasswords.map((pwd: string, idx: number) => {
        const previewLen = 4;
        const prefix = pwd ? pwd.slice(0, Math.min(previewLen, pwd.length)) : '';
        return `${prefix}••••(#${idx + 1})`;
      });
    }
    console.log('[settings] PUT /api/settings request', logBody);

    // Validate that only allowed fields are present
    const allowedFields = ['conflict', 'outputMode', 'zipSlipPolicy', 'commonPasswords', 'passwordMasking'];
    const providedFields = Object.keys(request.body);
    const invalidFields = providedFields.filter(field => !allowedFields.includes(field));
    
    if (invalidFields.length > 0) {
      reply.code(400);
      return { error: `Invalid fields: ${invalidFields.join(', ')}. Allowed fields: ${allowedFields.join(', ')}` };
    }

    // Require all three core fields to be present when saving settings
    const missingFields: string[] = [];
    if (conflict === undefined || conflict === null || conflict === '') {
      missingFields.push('conflict');
    }
    if (outputMode === undefined || outputMode === null || outputMode === '') {
      missingFields.push('outputMode');
    }
    if (zipSlipPolicy === undefined || zipSlipPolicy === null || zipSlipPolicy === '') {
      missingFields.push('zipSlipPolicy');
    }

    if (missingFields.length > 0) {
      reply.code(400);
      return {
        error: 'SETTINGS_MISSING_FIELDS',
        missing: missingFields,
        message: 'All settings fields (conflict, outputMode, zipSlipPolicy) must be provided when saving.'
      };
    }

    const updates: any = {
      conflict,
      outputMode,
      zipSlipPolicy
    };

    // Optional fields
    if (commonPasswords !== undefined) {
      updates.commonPasswords = commonPasswords;
    }
    if (passwordMasking !== undefined) {
      updates.passwordMasking = passwordMasking;
    }

    const settings = await updateSettings(db, updates);
    return settings;
  } catch (err: any) {
    reply.code(400);
    return { error: err.message };
  }
});

app.post('/api/scan', async (request: any, reply) => {
  const { rootPath, recursive = true, exts = ['.zip', '.cbz'], ignoreDirs = ['@eaDir', '#recycle', '.Trash'] } = request.body;

  if (!rootPath) {
    reply.code(400);
    return { error: 'rootPath is required' };
  }

  try {
    const result = await scanDirectory(rootPath, { recursive, exts, ignoreDirs });
    return result;
  } catch (err: any) {
    reply.code(500);
    return { error: err.message };
  }
});

// POST /api/jobs is removed - use POST /api/job-submissions instead
// This endpoint is now read-only (GET /api/jobs, GET /api/jobs/:id, POST /api/jobs/:id/start)
app.post('/api/jobs', async (request: any, reply) => {
  reply.code(404);
  return { error: 'POST /api/jobs is deprecated. Use POST /api/job-submissions instead.' };
});

/**
 * Normalize jobOptions from request body
 * Supports multiple field paths for compatibility (no defaults)
 * Returns { jobOptions, source }
 */
function normalizeJobOptions(body: any): { jobOptions: any; source: string } {
  const result: any = {};
  let source = 'unknown';
  
  // Try different paths in priority order
  // Priority a) body.jobOptions.conflictPolicy / outputMode / zipSlipPolicy
  if (body.jobOptions && typeof body.jobOptions === 'object') {
    const jo = body.jobOptions;
    // Check if this path has any of the required fields
    if (jo.conflictPolicy !== undefined || jo.conflict !== undefined || 
        jo.outputMode !== undefined || jo.zipSlipPolicy !== undefined) {
      result.conflictPolicy = jo.conflictPolicy ?? jo.conflict; // Support legacy 'conflict' field
      result.outputMode = jo.outputMode;
      result.zipSlipPolicy = jo.zipSlipPolicy;
      if (jo.passwordCandidates !== undefined) {
        result.passwordCandidates = jo.passwordCandidates;
      }
      source = jo.conflict !== undefined && jo.conflictPolicy === undefined 
        ? 'jobOptions.conflict' 
        : 'jobOptions';
      // Once we found a path, return immediately (don't try other paths)
      return { jobOptions: result, source };
    }
  }
  
  // Priority b) body.options_json.conflictPolicy / outputMode / zipSlipPolicy
  if (body.options_json && typeof body.options_json === 'object') {
    const oj = body.options_json;
    if (oj.conflictPolicy !== undefined || oj.conflict !== undefined || 
        oj.outputMode !== undefined || oj.zipSlipPolicy !== undefined) {
      result.conflictPolicy = oj.conflictPolicy ?? oj.conflict;
      result.outputMode = oj.outputMode;
      result.zipSlipPolicy = oj.zipSlipPolicy;
      if (oj.passwordCandidates !== undefined) {
        result.passwordCandidates = oj.passwordCandidates;
      }
      if (oj.passwordMode !== undefined) {
        result.passwordMode = oj.passwordMode;
        result.passwordValue = oj.passwordValue;
        result.passwordRefIndex = oj.passwordRefIndex;
        result.passwordTryOrder = oj.passwordTryOrder;
      }
      source = oj.conflict !== undefined && oj.conflictPolicy === undefined 
        ? 'options_json.conflict' 
        : 'options_json';
      return { jobOptions: result, source };
    }
  }
  
  // Priority c) body.jobOptions.options_json.conflictPolicy / outputMode / zipSlipPolicy
  if (body.jobOptions && typeof body.jobOptions === 'object') {
    const jooj = body.jobOptions.options_json;
    if (jooj && typeof jooj === 'object') {
      if (jooj.conflictPolicy !== undefined || jooj.conflict !== undefined || 
          jooj.outputMode !== undefined || jooj.zipSlipPolicy !== undefined) {
        result.conflictPolicy = jooj.conflictPolicy ?? jooj.conflict;
        result.outputMode = jooj.outputMode;
        result.zipSlipPolicy = jooj.zipSlipPolicy;
        if (jooj.passwordCandidates !== undefined) {
          result.passwordCandidates = jooj.passwordCandidates;
        }
        if (jooj.passwordMode !== undefined) {
          result.passwordMode = jooj.passwordMode;
          result.passwordValue = jooj.passwordValue;
          result.passwordRefIndex = jooj.passwordRefIndex;
          result.passwordTryOrder = jooj.passwordTryOrder;
        }
        source = jooj.conflict !== undefined && jooj.conflictPolicy === undefined 
          ? 'jobOptions.options_json.conflict' 
          : 'jobOptions.options_json';
        return { jobOptions: result, source };
      }
    }
  }
  
  // No path found, return empty result
  return { jobOptions: result, source };
}

// New endpoint: POST /api/job-submissions - Submit a new job with explicit jobOptions
app.post('/api/job-submissions', async (request: any, reply) => {
  const { rootPath, items } = request.body;

  // Validate required fields
  if (!rootPath) {
    reply.code(400);
    return { error: 'rootPath is required' };
  }

  if (!Array.isArray(items) || items.length === 0) {
    reply.code(400);
    return { error: 'items must be a non-empty array' };
  }

  // Normalize jobOptions from request body (supports multiple paths)
  const { jobOptions, source } = normalizeJobOptions(request.body);
  
  // Get received jobOptions keys for debug (avoid logging full body with items)
  const receivedJobOptionsKeys = request.body.jobOptions 
    ? Object.keys(request.body.jobOptions) 
    : [];

  // Validate jobOptions fields (no defaults, no DB fallback)
  const missingFields: string[] = [];
  if (!jobOptions.conflictPolicy || jobOptions.conflictPolicy === null || jobOptions.conflictPolicy === '') {
    missingFields.push('conflictPolicy');
  }
  if (!jobOptions.outputMode || jobOptions.outputMode === null || jobOptions.outputMode === '') {
    missingFields.push('outputMode');
  }
  if (!jobOptions.zipSlipPolicy || jobOptions.zipSlipPolicy === null || jobOptions.zipSlipPolicy === '') {
    missingFields.push('zipSlipPolicy');
  }

  if (missingFields.length > 0) {
    reply.code(400);
    return { 
      error: 'JOB_OPTIONS_MISSING',
      missing: missingFields,
      message: 'JobOptions must be fully resolved before calling createJob.',
      debug: {
        source: source,
        receivedJobOptionsKeys: receivedJobOptionsKeys,
        normalizedJobOptions: jobOptions
      }
    };
  }

  // Validate password mode and related fields
  const passwordMode = jobOptions.passwordMode || 'none';
  if (passwordMode !== 'none') {
    if (passwordMode === 'manual') {
      if (!jobOptions.passwordValue || jobOptions.passwordValue.trim() === '') {
        reply.code(400);
        return { error: 'passwordMode=manual requires passwordValue to be non-empty' };
      }
    } else if (passwordMode === 'select') {
      if (jobOptions.passwordRefIndex === undefined || jobOptions.passwordRefIndex === null) {
        reply.code(400);
        return { error: 'passwordMode=select requires passwordRefIndex' };
      }
      // Validate passwordRefIndex range (need to get settings first)
      const settings = await getSettings(db);
      const commonPasswords = settings?.commonPasswords || [];
      if (jobOptions.passwordRefIndex < 0 || jobOptions.passwordRefIndex >= commonPasswords.length) {
        reply.code(400);
        return { error: `passwordRefIndex ${jobOptions.passwordRefIndex} is out of range [0, ${commonPasswords.length})` };
      }
    } else if (passwordMode === 'try_list') {
      const settings = await getSettings(db);
      const commonPasswords = settings?.commonPasswords || [];
      if (commonPasswords.length === 0) {
        reply.code(400);
        return { error: 'passwordMode=try_list requires commonPasswords to be non-empty. Please add passwords in settings first.' };
      }
    }
  }

  // Validate enum values
  const allowedConflictPolicies = ['skip', 'overwrite', 'rename'];
  if (!allowedConflictPolicies.includes(jobOptions.conflictPolicy)) {
    reply.code(400);
    return {
      error: `Invalid conflictPolicy value: ${jobOptions.conflictPolicy}. Must be one of: ${allowedConflictPolicies.join(', ')}`,
      debug: {
        source: source,
        receivedJobOptionsKeys: receivedJobOptionsKeys,
        normalizedJobOptions: jobOptions
      }
    };
  }

  const allowedOutputModes = ['sibling_named_dir', 'in_place', 'custom'];
  if (!allowedOutputModes.includes(jobOptions.outputMode)) {
    reply.code(400);
    return {
      error: `Invalid outputMode value: ${jobOptions.outputMode}. Must be one of: ${allowedOutputModes.join(', ')}`,
      debug: {
        source: source,
        receivedJobOptionsKeys: receivedJobOptionsKeys,
        normalizedJobOptions: jobOptions
      }
    };
  }

  const allowedZipSlipPolicies = ['block', 'allow'];
  if (!allowedZipSlipPolicies.includes(jobOptions.zipSlipPolicy)) {
    reply.code(400);
    return {
      error: `Invalid zipSlipPolicy value: ${jobOptions.zipSlipPolicy}. Must be one of: ${allowedZipSlipPolicies.join(', ')}`,
      debug: {
        source: source,
        receivedJobOptionsKeys: receivedJobOptionsKeys,
        normalizedJobOptions: jobOptions
      }
    };
  }

  // Validate overwriteMode if provided (must be whitelisted)
  if (jobOptions.overwriteMode !== undefined) {
    const allowedModes = ['aoa', 'aos', 'aou', 'aot'];
    if (!allowedModes.includes(jobOptions.overwriteMode)) {
      reply.code(400);
      return { 
        error: `Invalid overwriteMode, allowed: aoa,aos,aou,aot`,
        details: { provided: jobOptions.overwriteMode },
        debug: {
          source: source,
          receivedJobOptionsKeys: receivedJobOptionsKeys,
          normalizedJobOptions: jobOptions
        }
      };
    }
  }

  try {
    // Calculate outDir for each item
    const jobItems = items.map((itemPath: string) => {
      const dir = path.dirname(itemPath);
      const basename = path.basename(itemPath, path.extname(itemPath));
      const outDir = path.join(dir, basename);
      return {
        archivePath: itemPath,
        ext: path.extname(itemPath),
        outDir
      };
    });

    // Build job options (overwriteMode is optional, no defaults)
    // Note: overwriteMode can be single letter suffix ('s', 'a', 'u') or full format ('aos', 'aoa', 'aou')
    interface JobOptionsData {
      rootPath: string;
      conflictPolicy?: ConflictPolicy;
      outputMode?: OutputMode;
      zipSlipPolicy?: 'block' | 'allow';
      overwriteMode?: string; // Accept both single letter and full format
      passwordMode?: JobOptions['passwordMode'];
      passwordValue?: string;
      passwordRefIndex?: number;
      passwordTryOrder?: 'as_is';
    }
    
    const jobOptionsData: JobOptionsData = {
      rootPath,
      conflictPolicy: jobOptions.conflictPolicy,
      outputMode: jobOptions.outputMode,
      zipSlipPolicy: jobOptions.zipSlipPolicy
    };
    
    // Convert conflictPolicy to overwriteMode for 7z
    // Note: 7z-args.ts will automatically add '-ao' prefix, so we only need to provide the suffix letter
    // Mapping: skip -> 's' (becomes -aos), overwrite -> 'a' (becomes -aoa), rename -> 'u' (becomes -aou)
    const conflictPolicyToOverwriteMode: Record<ConflictPolicy, 's' | 'a' | 'u'> = {
      'skip': 's',
      'overwrite': 'a',
      'rename': 'u'
    };
    
    // Priority: use overwriteMode if explicitly provided, otherwise convert from conflictPolicy
    if (jobOptions.overwriteMode !== undefined) {
      jobOptionsData.overwriteMode = jobOptions.overwriteMode;
    } else if (jobOptions.conflictPolicy) {
      // Convert conflictPolicy to overwriteMode (single letter suffix)
      // conflictPolicy is already validated above (line 357-368), so it's safe to cast
      const conflictPolicy = jobOptions.conflictPolicy as ConflictPolicy;
      const suffix = conflictPolicyToOverwriteMode[conflictPolicy];
      // Pass single letter suffix to 7z-args.ts (it will add -ao prefix)
      jobOptionsData.overwriteMode = suffix;
    } else {
      // Default to skip ('s' suffix, becomes -aos)
      jobOptionsData.overwriteMode = 's';
    }

    // Add password fields if provided
    if (jobOptions.passwordMode !== undefined) {
      jobOptionsData.passwordMode = jobOptions.passwordMode;
      if (jobOptions.passwordValue !== undefined) {
        jobOptionsData.passwordValue = jobOptions.passwordValue;
      }
      if (jobOptions.passwordRefIndex !== undefined) {
        jobOptionsData.passwordRefIndex = jobOptions.passwordRefIndex;
      }
      if (jobOptions.passwordTryOrder !== undefined) {
        jobOptionsData.passwordTryOrder = jobOptions.passwordTryOrder;
      }
    }
    
    // Log received jobOptions with source info (mask password value if present)
    const logJobOptions = { ...jobOptionsData };
    if (logJobOptions.passwordValue) {
      logJobOptions.passwordValue = '***MASKED***';
    }
    console.log(`[KaijuanJobSubmit] rootPath=${rootPath} items=${items.length} source=${source} jobOptions=${JSON.stringify(logJobOptions)}`);
    
    // Create job with validated options
    // Convert JobOptionsData to JobOptions (overwriteMode is stored as string, which is compatible)
    const jobOptionsForCreate: JobOptions = {
      ...jobOptionsData,
      overwriteMode: jobOptionsData.overwriteMode as JobOptions['overwriteMode'] | undefined
    };
    
    const createOptions: CreateJobOptions = {
      rootPath,
      outputMode: jobOptions.outputMode!,
      conflictPolicy: jobOptions.conflictPolicy!,
      options: jobOptionsForCreate,
      items: jobItems
    };

    const jobId = await createJob(db, createOptions);
    await enqueueJob(db, jobId);

    return { jobId };
  } catch (err: any) {
    // If validation error from createJob, return 400 with proper format
    if (err.message && err.message.includes('JobOptions must be fully resolved')) {
      reply.code(400);
      // Extract missing fields from error message if possible
      const missingMatch = err.message.match(/Missing required fields: (.+)/);
      const missing = missingMatch 
        ? missingMatch[1].split(',').map((f: string) => f.trim())
        : ['conflictPolicy', 'outputMode', 'zipSlipPolicy'];
      
      return {
        error: 'JOB_OPTIONS_MISSING',
        missing: missing,
        message: 'JobOptions must be fully resolved before calling createJob.'
      };
    }
    // Other validation errors
    if (err.message && (err.message.includes('MISSING_JOB_OPTIONS') || err.message.includes('Invalid'))) {
      reply.code(400);
      return { error: err.message };
    }
    // Unexpected errors
    console.error('[JobSubmission] Unexpected error:', err);
    reply.code(500);
    return { error: err.message || 'Internal server error' };
  }
});

app.post('/api/jobs/:id/start', async (request: any, reply) => {
  const jobId = parseInt(request.params.id);

  try {
    await enqueueJob(db, jobId);
    return { ok: true, message: 'Job started' };
  } catch (err: any) {
    reply.code(500);
    return { error: err.message };
  }
});

app.get('/api/jobs', async (request, reply) => {
  try {
    const jobs = await listJobs(db, 50);
    return { jobs };
  } catch (err: any) {
    reply.code(500);
    return { error: err.message };
  }
});

app.get('/api/jobs/:id', async (request: any, reply) => {
  const jobId = parseInt(request.params.id);

  try {
    const job = await getJob(db, jobId);
    if (!job) {
      reply.code(404);
      return { error: 'Job not found' };
    }

    const items = await listJobItems(db, jobId, 2000);
    return { job, items };
  } catch (err: any) {
    reply.code(500);
    return { error: err.message };
  }
});

app.get('/api/jobs/:id/log', async (request: any, reply) => {
  const jobId = parseInt(request.params.id);

  try {
    // Get job to retrieve log_path
    const job = await getJob(db, jobId);
    if (!job) {
      reply.code(404);
      return { error: 'Job not found' };
    }

    // Construct log file path (same logic as in worker.ts)
    const logPath = job.log_path || path.join(getVarDir(), 'logs', `job-${job.id}.log`);

    // Check if file exists
    if (!fs.existsSync(logPath)) {
      reply.code(404);
      return { error: 'Log file not found', content: '' };
    }

    // Read file content (utf-8)
    const content = fs.readFileSync(logPath, 'utf-8');
    
    return { content };
  } catch (err: any) {
    reply.code(500);
    return { error: err.message || 'Failed to read log file' };
  }
});

app.delete('/api/jobs/:id', async (request: any, reply) => {
  const jobId = parseInt(request.params.id);

  try {
    await deleteJob(db, jobId);
    return { ok: true };
  } catch (err: any) {
    // Handle JOB_NOT_DELETABLE error (not in terminal state)
    if (err.message && err.message.includes('JOB_NOT_DELETABLE')) {
      reply.code(409);
      return {
        error: 'JOB_NOT_DELETABLE',
        message: 'Job is not in terminal state, cannot delete'
      };
    }
    // Handle not found
    if (err.message && err.message.includes('not found')) {
      reply.code(404);
      return { error: 'Job not found' };
    }
    // Other errors
    reply.code(500);
    return { error: err.message || 'Internal server error' };
  }
});

app.post('/api/jobs/clear-failed', async (request: any, reply) => {
  try {
    const deletedCount = await clearFailedJobs(db);
    return { deletedCount };
  } catch (err: any) {
    reply.code(500);
    return { error: err.message || 'Internal server error' };
  }
});

// File system browsing API
// GET /api/fs/roots - Get root directories
app.get('/api/fs/roots', async (request, reply) => {
  try {
    const roots: Array<{ path: string; label: string; source: string }> = [];
    const seenPaths = new Set<string>();
    
    // Helper: Add path if accessible and not duplicate
    const addPathIfAccessible = async (p: string, label: string, source: string): Promise<boolean> => {
      if (!p || seenPaths.has(p)) return false;
      try {
        await fs.promises.access(p, fs.constants.R_OK);
        roots.push({ path: p, label, source });
        seenPaths.add(p);
        return true;
      } catch (err) {
        // Skip if not accessible
        return false;
      }
    };
    
    // A. TRIM_DATA_SHARE_PATHS (priority: data-share)
    const trimDataSharePaths = process.env.TRIM_DATA_SHARE_PATHS || '';
    const dataSharePaths: string[] = [];
    if (trimDataSharePaths) {
      const paths = trimDataSharePaths.split(':').map(p => p.trim()).filter(p => p);
      // Remove duplicates
      const uniquePaths = Array.from(new Set(paths));
      for (const p of uniquePaths) {
        if (p) {
          const resolved = path.resolve(p);
          const added = await addPathIfAccessible(resolved, `DataShare: ${path.basename(resolved)}`, 'data-share');
          if (added) {
            dataSharePaths.push(resolved);
          }
        }
      }
    }
    
    // B. Application paths (priority: trim)
    const appPaths = [
      { env: 'TRIM_PKGHOME', label: 'TRIM_PKGHOME' },
      { env: 'TRIM_PKGVAR', label: 'TRIM_PKGVAR' },
      { env: 'TRIM_PKGTMP', label: 'TRIM_PKGTMP' },
      { env: 'TRIM_PKGETC', label: 'TRIM_PKGETC' },
      { env: 'TRIM_APPDEST', label: 'TRIM_APPDEST' },
      { env: 'APPROOT', label: 'APPROOT' }
    ];
    
    for (const item of appPaths) {
      const envPath = process.env[item.env];
      if (envPath) {
        await addPathIfAccessible(envPath, item.label, 'trim');
      }
    }
    
    // Add current working directory
    const cwd = process.cwd();
    await addPathIfAccessible(cwd, 'App Workdir', 'trim');
    
    // C. Common volume paths (priority: probe)
    // Read from environment variable COMMON_VOLUME_PATHS (colon-separated, e.g., "/vol1:/vol2:/mnt:/data")
    const commonVolumePathsEnv = process.env.COMMON_VOLUME_PATHS || '';
    if (commonVolumePathsEnv) {
      const commonPaths = commonVolumePathsEnv
        .split(':')
        .map(p => p.trim())
        .filter(p => p && p.startsWith('/')); // Only absolute paths
      
      for (const commonPath of commonPaths) {
        const label = path.basename(commonPath) || commonPath;
        await addPathIfAccessible(commonPath, label, 'probe');
      }
    }
    
    // Add root "/" as fallback
    await addPathIfAccessible('/', 'Root', 'fallback');
    
    // Add home directory as fallback
    const home = os.homedir();
    if (home && home !== '/') {
      await addPathIfAccessible(home, 'Home', 'fallback');
    }
    
    // Sort roots by priority: data-share > trim > probe > fallback
    const sourcePriority: { [key: string]: number } = {
      'data-share': 0,
      'trim': 1,
      'probe': 2,
      'fallback': 3
    };
    roots.sort((a, b) => {
      const priorityA = sourcePriority[a.source] ?? 99;
      const priorityB = sourcePriority[b.source] ?? 99;
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }
      return a.path.localeCompare(b.path);
    });
    
    // Debug information
    interface DebugInfo {
      TRIM_DATA_SHARE_PATHS: string;
      COMMON_VOLUME_PATHS?: string;
      user: {
        uid?: number;
        gid?: number;
      };
      runUserEnv: string;
      appUserEnv: string;
    }
    
    const debug: DebugInfo = {
      TRIM_DATA_SHARE_PATHS: trimDataSharePaths || '',
      COMMON_VOLUME_PATHS: commonVolumePathsEnv || undefined,
      user: {},
      runUserEnv: process.env.TRIM_RUN_USERNAME || '',
      appUserEnv: process.env.TRIM_USERNAME || ''
    };
    
    if (typeof process.getuid === 'function') {
      debug.user.uid = process.getuid();
    }
    if (typeof process.getgid === 'function') {
      debug.user.gid = process.getgid();
    }
    
    return { roots, debug };
  } catch (err: any) {
    reply.code(500);
    return { error: err.message };
  }
});

// GET /api/fs/list - List directory contents
app.get('/api/fs/list', async (request: any, reply) => {
  try {
    const { path: reqPath, includeFiles = '0', limit = '200' } = request.query;
    
    if (!reqPath || typeof reqPath !== 'string') {
      reply.code(400);
      return { error: 'path parameter is required' };
    }
    
    // Normalize and resolve path
    const normalizedPath = path.normalize(reqPath);
    const resolvedPath = path.resolve(normalizedPath);
    
    // Security: Block system pseudo-filesystems
    const blockedPrefixes = ['/proc', '/sys', '/dev'];
    for (const prefix of blockedPrefixes) {
      if (resolvedPath.startsWith(prefix) && resolvedPath !== prefix) {
        reply.code(403);
        return { error: 'Path not allowed' };
      }
    }
    
    // Check if path exists and is accessible
    let stats;
    try {
      stats = await fs.promises.stat(resolvedPath);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        reply.code(404);
        return { 
          error: 'Path not found',
          message: 'Path not found',
          path: resolvedPath
        };
      } else if (err.code === 'EACCES' || err.code === 'EPERM') {
        reply.code(403);
        return { 
          error: 'Permission denied',
          message: 'Permission denied',
          path: resolvedPath,
          hint: 'Check fnOS authorization and whether path is included in roots (TRIM_DATA_SHARE_PATHS)'
        };
      }
      throw err;
    }
    
    if (!stats.isDirectory()) {
      reply.code(400);
      return { error: 'Path is not a directory' };
    }
    
    // Read directory
    const includeFilesFlag = includeFiles === '1' || includeFiles === 'true';
    const limitNum = Math.min(parseInt(limit) || 200, 500);
    
    const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
    const items: Array<{ name: string; path: string; isDir: boolean; size: number; mtime: string }> = [];
    
    for (const entry of entries) {
      // Skip . and ..
      if (entry.name === '.' || entry.name === '..') {
        continue;
      }
      
      // Filter: if includeFiles=0, only include directories
      if (!includeFilesFlag && !entry.isDirectory()) {
        continue;
      }
      
      // Limit check
      if (items.length >= limitNum) {
        break;
      }
      
      const itemPath = path.join(resolvedPath, entry.name);
      try {
        const itemStats = await fs.promises.stat(itemPath);
        items.push({
          name: entry.name,
          path: itemPath,
          isDir: itemStats.isDirectory(),
          size: itemStats.size,
          mtime: itemStats.mtime.toISOString()
        });
      } catch (err) {
        // Skip items that can't be stat'd
        continue;
      }
    }
    
    // Sort by name
    items.sort((a, b) => a.name.localeCompare(b.name));
    
    const truncated = entries.length > limitNum;
    
    return {
      path: resolvedPath,
      items,
      truncated
    };
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      reply.code(404);
      return { 
        error: 'Path not found',
        message: 'Path not found',
        path: request.query.path
      };
    } else if (err.code === 'EACCES' || err.code === 'EPERM') {
      reply.code(403);
      return { 
        error: 'Permission denied',
        message: 'Permission denied',
        path: request.query.path,
        hint: 'Check fnOS authorization and whether path is included in roots (TRIM_DATA_SHARE_PATHS)'
      };
    }
    reply.code(500);
    return { error: err.message };
  }
});

// POST /api/jobs/:id/retry - Retry a failed job with new password options
app.post('/api/jobs/:id/retry', async (request: any, reply) => {
  const jobId = parseInt(request.params.id);
  const { passwordMode, passwordValue, passwordRefIndex } = request.body;

  try {
    // Validate required fields
    if (!passwordMode) {
      reply.code(400);
      return { error: 'passwordMode is required' };
    }

    // Validate password mode
    const allowedModes = ['none', 'select', 'manual', 'try_list'];
    if (!allowedModes.includes(passwordMode)) {
      reply.code(400);
      return { error: `Invalid passwordMode: ${passwordMode}. Must be one of: ${allowedModes.join(', ')}` };
    }

    // Validate password mode specific fields
    if (passwordMode === 'manual') {
      if (!passwordValue || passwordValue.trim() === '') {
        reply.code(400);
        return { error: 'passwordMode=manual requires passwordValue to be non-empty' };
      }
    } else if (passwordMode === 'select') {
      if (passwordRefIndex === undefined || passwordRefIndex === null) {
        reply.code(400);
        return { error: 'passwordMode=select requires passwordRefIndex' };
      }
      // Validate passwordRefIndex range
      const settings = await getSettings(db);
      const commonPasswords = settings?.commonPasswords || [];
      if (passwordRefIndex < 0 || passwordRefIndex >= commonPasswords.length) {
        reply.code(400);
        return { error: `passwordRefIndex ${passwordRefIndex} is out of range [0, ${commonPasswords.length})` };
      }
    } else if (passwordMode === 'try_list') {
      // Validate common passwords list is not empty
      const settings = await getSettings(db);
      const commonPasswords = settings?.commonPasswords || [];
      if (commonPasswords.length === 0) {
        reply.code(400);
        return { error: 'passwordMode=try_list requires commonPasswords to be non-empty. Please add passwords in settings first.' };
      }
    }

    // Retry the job
    const newJobId = await retryJob(db, jobId, {
      passwordMode,
      passwordValue,
      passwordRefIndex
    });

    // Enqueue the new job
    await enqueueJob(db, newJobId);

    return {
      jobId: newJobId,
      retryFromJobId: jobId,
      message: `Retry job ${newJobId} created from failed job ${jobId}`
    };
  } catch (err: any) {
    // Handle specific errors
    if (err.message && err.message.includes('not found')) {
      reply.code(404);
      return { error: 'Job not found' };
    }
    if (err.message && err.message.includes('not in failed status')) {
      reply.code(409);
      return { error: err.message };
    }
    reply.code(500);
    return { error: err.message || 'Internal server error' };
  }
});

// Helper function for scanning
async function scanDirectory(rootPath: string, options: any) {
  const {
    recursive = true,
    exts = ['.zip', '.cbz'],
    ignoreDirs = ['@eaDir', '#recycle', '.Trash'],
    maxItems = 5000
  } = options;

  const items: any[] = [];
  const extSet = new Set(exts.map((e: string) => e.toLowerCase()));
  const ignoreSet = new Set(ignoreDirs);

  async function scanDir(dir: string, depth: number = 0) {
    if (items.length >= maxItems) return;

    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (items.length >= maxItems) break;

        if (entry.isDirectory()) {
          if (ignoreSet.has(entry.name)) continue;
          if (recursive) {
            await scanDir(path.join(dir, entry.name), depth + 1);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extSet.has(ext)) {
            const fullPath = path.join(dir, entry.name);
            try {
              const stat = await fs.promises.stat(fullPath);
              items.push({
                path: fullPath,
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                ext: ext
              });
            } catch (err) {
              // Ignore inaccessible files
            }
          }
        }
      }
    } catch (err) {
      // Ignore inaccessible directories
    }
  }

  await scanDir(rootPath);

  return {
    total: items.length,
    items: items,
    truncated: items.length >= maxItems
  };
}

// Register static file service (after API routes to ensure API routes have priority)
const fastifyStatic = require('@fastify/static');
// Resolve www directory:
// - Docker: /app/www (when running from /app/server/dist/index.js, __dirname is /app/server/dist, so ../.. resolves to /app)
// - Local dev: app/www relative to dist directory
// - Can also be overridden via WWW_PATH environment variable
const wwwPath = process.env.WWW_PATH || path.join(__dirname, '..', '..', 'www');
app.register(fastifyStatic, {
  root: wwwPath,
  prefix: '/'
});

// Start server
async function start() {
  try {
    // Check 7z availability first (before starting server)
    try {
      const sevenZipPath = await resolve7zPath();
      console.log(`[Boot] 7z=${sevenZipPath}`);
    } catch (err: any) {
      console.error(`[Boot] 7z resolution failed: ${err.message}`);
      console.error('[Boot] Service cannot start without 7z. Exiting.');
      process.exit(1);
    }

    // Initialize database
    await migrate(db);

    // Ensure default settings exist (insert if not present)
    const existingSettings = await getSettings(db);
    if (!existingSettings) {
      console.log('[KaijuanBoot] No settings found, inserting default settings...');
      await updateSettings(db, DEFAULT_SETTINGS);
      console.log('[KaijuanBoot] Default settings inserted successfully');
    }

    // Reconcile on boot (must be before worker)
    await reconcileOnBoot(db);

    // Start worker loop
    startWorkerLoop();
    console.log('[KaijuanBoot] Worker loop started');

    // Log TRIM_DATA_SHARE_PATHS and accessible roots
    const trimDataSharePaths = process.env.TRIM_DATA_SHARE_PATHS || '';
    console.log(`[KaijuanBoot] TRIM_DATA_SHARE_PATHS: ${trimDataSharePaths || '(empty)'}`);
    if (trimDataSharePaths) {
      const paths = trimDataSharePaths.split(':').map(p => p.trim()).filter(p => p);
      const uniquePaths = Array.from(new Set(paths));
      console.log(`[KaijuanBoot] Parsed data-share paths: ${uniquePaths.join(', ')}`);
      for (const p of uniquePaths) {
        try {
          await fs.promises.access(p, fs.constants.R_OK);
          console.log(`[KaijuanBoot]   ✓ ${p} (readable)`);
        } catch (err: any) {
          console.log(`[KaijuanBoot]   ✗ ${p} (not readable: ${err.code || err.message})`);
        }
      }
    }

    const port = parseInt(process.env.PORT || '30080');
    const host = process.env.HOST || '0.0.0.0';

    await app.listen({ port, host });
    console.log(`Server listening at http://${host}:${port}`);
  } catch (err) {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  }
}

start();
