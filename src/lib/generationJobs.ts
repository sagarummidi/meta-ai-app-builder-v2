import type { GeneratedFile, PipelineTimingInfo, PlannedFile } from "./jsonRecovery";
import { Pool, type QueryResult } from "pg";
import { sanitizeErrorMessage } from "./modelRouter";

export type GenerationJobStatus =
  | "pending"
  | "planning"
  | "generating_shared"
  | "generating_components"
  | "generating_entry"
  | "validating"
  | "recovering"
  | "completed"
  | "failed";

export interface GenerationJobResult {
  files: GeneratedFile[];
  dependencies: Record<string, string>;
  generatedCode: string;
  usedModel: string;
  usedProvider: string;
  fallbackUsed: boolean;
  fallbackNotice?: string;
  timings?: PipelineTimingInfo;
}

export interface GenerationJob {
  id: string;
  prompt: string;
  provider: string;
  model: string;
  status: GenerationJobStatus;
  stageMessage: string;
  progressPercent: number;
  completedFilePaths: string[];
  pendingFilePaths?: string[];
  failedFilePaths?: string[];
  partialFiles?: GeneratedFile[];
  manifest?: PlannedFile[];
  createdAt: number;
  updatedAt: number;
  result?: GenerationJobResult;
  error?: string;
  statusCode?: number;
  version?: number;
  resumeLockWorker?: string;
  resumeLockExpiresAt?: number;
}

export const DEFAULT_JOB_TTL_MS = 60 * 60 * 1000; // 1 hour TTL default
export const MAX_GENERATION_DURATION_MS = 10 * 60 * 1000; // 10 minutes (600,000 ms)
export const MAX_JOB_CLEANUP_GRACE_PERIOD_MS = 30 * 1000; // 30 seconds grace period
export const MAX_JOB_ACTIVE_DURATION_MS =
  MAX_GENERATION_DURATION_MS + MAX_JOB_CLEANUP_GRACE_PERIOD_MS; // 630,000 ms (10.5 minutes)
export const DEFAULT_STALE_JOB_THRESHOLD_MS = 60 * 1000; // 1 minute without progress indicates interrupted job
export const DEFAULT_RESUME_LOCK_TTL_MS = 60 * 1000; // 1 minute distributed resume lock TTL

export function mergeJobFiles(
  base: GeneratedFile[],
  additions: GeneratedFile[]
): GeneratedFile[] {
  const map = new Map<string, GeneratedFile>();
  for (const f of base) {
    if (f && typeof f.path === "string") {
      const norm = f.path.replace(/\\/g, "/").replace(/^\.\//, "").trim();
      map.set(norm, { path: norm, code: f.code });
    }
  }
  for (const f of additions) {
    if (f && typeof f.path === "string") {
      const norm = f.path.replace(/\\/g, "/").replace(/^\.\//, "").trim();
      map.set(norm, { path: norm, code: f.code });
    }
  }
  return Array.from(map.values());
}

export interface IGenerationJobStore {
  createJob(
    id: string,
    prompt: string,
    provider: string,
    model: string,
    initialFiles?: GeneratedFile[],
    initialManifest?: PlannedFile[]
  ): GenerationJob | Promise<GenerationJob>;

  getJob(id: string): GenerationJob | undefined | Promise<GenerationJob | undefined>;

  updateJobProgress(
    id: string,
    updates: {
      status?: GenerationJobStatus;
      stageMessage?: string;
      progressPercent?: number;
      completedFilePaths?: string[];
      pendingFilePaths?: string[];
      failedFilePaths?: string[];
      partialFiles?: GeneratedFile[];
      manifest?: PlannedFile[];
    }
  ): GenerationJob | undefined | Promise<GenerationJob | undefined>;

  completeJob(
    id: string,
    result: GenerationJobResult
  ): GenerationJob | undefined | Promise<GenerationJob | undefined>;

  failJob(
    id: string,
    error: string,
    statusCode?: number
  ): GenerationJob | undefined | Promise<GenerationJob | undefined>;

  acquireResumeLock(id: string, workerId: string, ttlMs?: number): Promise<boolean>;

  releaseResumeLock(id: string, workerId: string): Promise<void>;

  touchJob?(id: string, workerId?: string, ttlMs?: number): Promise<boolean>;

  renewResumeLock?(id: string, workerId: string, ttlMs?: number): Promise<boolean>;

  cleanupExpiredJobs(): Promise<number>;

  clear(): void | Promise<void>;

  close?(): Promise<void>;
}

// -----------------------------------------------------------------------------
// In-Memory Storage Implementation (for Development & Unit Tests)
// -----------------------------------------------------------------------------
export class MemoryJobStore implements IGenerationJobStore {
  private jobs = new Map<string, GenerationJob>();
  private resumeLocks = new Map<string, { workerId: string; expiresAt: number }>();
  private ttlMs: number;
  private staleJobThresholdMs: number;
  private resumeLockTtlMs: number;

  constructor(options?: {
    ttlMs?: number;
    staleJobThresholdMs?: number;
    resumeLockTtlMs?: number;
  }) {
    this.ttlMs = options?.ttlMs ?? parseInt(process.env.JOB_TTL_MS || String(DEFAULT_JOB_TTL_MS), 10);
    this.staleJobThresholdMs =
      options?.staleJobThresholdMs ??
      parseInt(process.env.STALE_JOB_THRESHOLD_MS || String(DEFAULT_STALE_JOB_THRESHOLD_MS), 10);
    this.resumeLockTtlMs =
      options?.resumeLockTtlMs ??
      parseInt(process.env.RESUME_LOCK_TTL_MS || String(DEFAULT_RESUME_LOCK_TTL_MS), 10);
  }

  public createJob(
    id: string,
    prompt: string,
    provider: string,
    model: string,
    initialFiles: GeneratedFile[] = [],
    initialManifest: PlannedFile[] = []
  ): GenerationJob {
    const now = Date.now();
    const job: GenerationJob = {
      id,
      prompt,
      provider,
      model,
      status: "pending",
      stageMessage: "Initializing application generation...",
      progressPercent: 5,
      completedFilePaths: initialFiles.map((f) => f.path),
      pendingFilePaths: [],
      failedFilePaths: [],
      partialFiles: [...initialFiles],
      manifest: [...initialManifest],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    this.jobs.set(id, job);
    return job;
  }

  public getJob(id: string): GenerationJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;

    const now = Date.now();
    // Check if expired
    if (now - job.createdAt > this.ttlMs) {
      this.jobs.delete(id);
      return undefined;
    }

    const isActive = job.status !== "completed" && job.status !== "failed";
    const isOverMaxDuration = now - job.createdAt > MAX_JOB_ACTIVE_DURATION_MS;
    const isStale = now - job.updatedAt > this.staleJobThresholdMs;

    if (isActive && (isOverMaxDuration || isStale)) {
      const errorMsg = isOverMaxDuration
        ? "Generation job exceeded maximum execution time (10m). Upstream model took too long to complete."
        : `Generation job was interrupted by a server restart. Preserved ${job.partialFiles?.length || 0} generated files. Use resumeJobId to continue generating remaining ${job.pendingFilePaths?.length || 0} files.`;

      this.failJob(id, errorMsg, 504);
    }

    return this.jobs.get(id);
  }

  public updateJobProgress(
    id: string,
    updates: {
      status?: GenerationJobStatus;
      stageMessage?: string;
      progressPercent?: number;
      completedFilePaths?: string[];
      pendingFilePaths?: string[];
      failedFilePaths?: string[];
      partialFiles?: GeneratedFile[];
      manifest?: PlannedFile[];
    }
  ): GenerationJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;

    if (updates.status) job.status = updates.status;
    if (updates.stageMessage) job.stageMessage = updates.stageMessage;
    if (typeof updates.progressPercent === "number") {
      job.progressPercent = Math.max(0, Math.min(100, updates.progressPercent));
    }
    if (updates.manifest && updates.manifest.length > 0) {
      job.manifest = updates.manifest;
    }
    if (updates.partialFiles && updates.partialFiles.length > 0) {
      job.partialFiles = mergeJobFiles(job.partialFiles || [], updates.partialFiles);
      const partialPaths = job.partialFiles.map((f) => f.path);
      job.completedFilePaths = Array.from(
        new Set([...job.completedFilePaths, ...partialPaths])
      );
    }
    if (updates.completedFilePaths) {
      job.completedFilePaths = Array.from(
        new Set([...job.completedFilePaths, ...updates.completedFilePaths])
      );
      if (job.pendingFilePaths) {
        job.pendingFilePaths = job.pendingFilePaths.filter(
          (p) => !job.completedFilePaths.includes(p)
        );
      }
    }
    if (updates.pendingFilePaths) {
      const activeCompleted = new Set(job.completedFilePaths);
      job.pendingFilePaths = Array.from(
        new Set(updates.pendingFilePaths.filter((p) => !activeCompleted.has(p)))
      );
    }
    if (updates.failedFilePaths) {
      job.failedFilePaths = Array.from(
        new Set([...(job.failedFilePaths || []), ...updates.failedFilePaths])
      );
      if (job.pendingFilePaths) {
        job.pendingFilePaths = job.pendingFilePaths.filter(
          (p) => !job.failedFilePaths?.includes(p)
        );
      }
    }
    job.version = (job.version || 1) + 1;
    job.updatedAt = Date.now();
    return job;
  }

  public completeJob(
    id: string,
    result: GenerationJobResult
  ): GenerationJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;

    job.status = "completed";
    job.stageMessage = "Application generation completed successfully.";
    job.progressPercent = 100;
    job.completedFilePaths = result.files.map((f) => f.path);
    job.pendingFilePaths = [];
    job.partialFiles = result.files;
    job.result = result;
    job.version = (job.version || 1) + 1;
    job.updatedAt = Date.now();
    return job;
  }

  public failJob(
    id: string,
    error: string,
    statusCode: number = 502
  ): GenerationJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;

    job.status = "failed";
    job.stageMessage = `Generation failed: ${error}`;
    job.error = error;
    job.statusCode = statusCode;
    job.version = (job.version || 1) + 1;
    job.updatedAt = Date.now();
    return job;
  }

  public async acquireResumeLock(
    id: string,
    workerId: string,
    ttlMs: number = this.resumeLockTtlMs
  ): Promise<boolean> {
    const now = Date.now();
    const existing = this.resumeLocks.get(id);
    if (existing && existing.expiresAt > now && existing.workerId !== workerId) {
      return false;
    }
    this.resumeLocks.set(id, { workerId, expiresAt: now + ttlMs });
    return true;
  }

  public async releaseResumeLock(id: string, workerId: string): Promise<void> {
    const existing = this.resumeLocks.get(id);
    if (existing && existing.workerId === workerId) {
      this.resumeLocks.delete(id);
    }
  }

  public async touchJob(id: string, workerId?: string, ttlMs?: number): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;
    const now = Date.now();
    job.updatedAt = now;

    if (workerId) {
      const existing = this.resumeLocks.get(id);
      if (existing && existing.workerId !== workerId && existing.expiresAt > now) {
        return false;
      }
      const lockTtl = ttlMs ?? this.resumeLockTtlMs;
      const expiresAt = now + lockTtl;
      this.resumeLocks.set(id, { workerId, expiresAt });
      job.resumeLockWorker = workerId;
      job.resumeLockExpiresAt = expiresAt;
    }
    return true;
  }

  public async renewResumeLock(id: string, workerId: string, ttlMs?: number): Promise<boolean> {
    return this.touchJob(id, workerId, ttlMs);
  }

  public async cleanupExpiredJobs(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [id, job] of this.jobs.entries()) {
      if (now - job.createdAt > this.ttlMs) {
        this.jobs.delete(id);
        this.resumeLocks.delete(id);
        removed++;
      }
    }
    return removed;
  }

  public clear(): void {
    this.jobs.clear();
    this.resumeLocks.clear();
  }
}

// -----------------------------------------------------------------------------
// PostgreSQL Durable Storage Implementation (for Production & Multi-Instance)
// -----------------------------------------------------------------------------
export interface IDatabaseClient {
  query(text: string, params?: unknown[]): Promise<QueryResult<any>>;
}

export class PostgresJobStore implements IGenerationJobStore {
  private pool: IDatabaseClient;
  private isExternalPool = false;
  private ttlMs: number;
  private staleJobThresholdMs: number;
  private resumeLockTtlMs: number;
  private initialized = false;
  private initPromise?: Promise<void>;

  constructor(options?: {
    pool?: IDatabaseClient;
    connectionString?: string;
    ttlMs?: number;
    staleJobThresholdMs?: number;
    resumeLockTtlMs?: number;
  }) {
    this.ttlMs = options?.ttlMs ?? parseInt(process.env.JOB_TTL_MS || String(DEFAULT_JOB_TTL_MS), 10);
    this.staleJobThresholdMs =
      options?.staleJobThresholdMs ??
      parseInt(process.env.STALE_JOB_THRESHOLD_MS || String(DEFAULT_STALE_JOB_THRESHOLD_MS), 10);
    this.resumeLockTtlMs =
      options?.resumeLockTtlMs ??
      parseInt(process.env.RESUME_LOCK_TTL_MS || String(DEFAULT_RESUME_LOCK_TTL_MS), 10);

    if (options?.pool) {
      this.pool = options.pool;
      this.isExternalPool = true;
    } else {
      const connStr = options?.connectionString || process.env.DATABASE_URL || process.env.POSTGRES_URL;
      if (!connStr) {
        if (process.env.NODE_ENV === "production") {
          throw new Error(
            "Production database configuration missing: Set DATABASE_URL or POSTGRES_URL to enable durable multi-instance generation job persistence."
          );
        }
      }
      this.pool = new Pool({
        connectionString: connStr,
        ssl: connStr?.includes("sslmode=disable")
          ? false
          : process.env.NODE_ENV === "production"
          ? { rejectUnauthorized: false }
          : undefined,
        max: parseInt(process.env.PG_MAX_POOL || "10", 10),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });
    }
  }

  public async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS generation_jobs (
            id VARCHAR(255) PRIMARY KEY,
            prompt TEXT NOT NULL,
            provider VARCHAR(50) NOT NULL,
            model VARCHAR(100) NOT NULL,
            status VARCHAR(50) NOT NULL,
            stage_message TEXT NOT NULL,
            progress_percent INTEGER NOT NULL DEFAULT 0,
            completed_file_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
            pending_file_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
            failed_file_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
            partial_files JSONB NOT NULL DEFAULT '[]'::jsonb,
            manifest JSONB NOT NULL DEFAULT '[]'::jsonb,
            result JSONB,
            error TEXT,
            status_code INTEGER,
            version INTEGER NOT NULL DEFAULT 1,
            resume_lock_worker VARCHAR(255),
            resume_lock_expires_at BIGINT,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL,
            expires_at BIGINT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_generation_jobs_expires_at ON generation_jobs (expires_at);
          CREATE INDEX IF NOT EXISTS idx_generation_jobs_status ON generation_jobs (status);
        `);
        this.initialized = true;
      } catch (err) {
        const safe = sanitizeErrorMessage(err instanceof Error ? err.message : "Database initialization failed.");
        throw new Error(`Database error: ${safe}`);
      }
    })();

    return this.initPromise;
  }

  private mapRowToJob(row: any): GenerationJob {
    return {
      id: row.id,
      prompt: row.prompt,
      provider: row.provider,
      model: row.model,
      status: row.status as GenerationJobStatus,
      stageMessage: row.stage_message,
      progressPercent: Number(row.progress_percent),
      completedFilePaths:
        typeof row.completed_file_paths === "string"
          ? JSON.parse(row.completed_file_paths)
          : row.completed_file_paths || [],
      pendingFilePaths:
        typeof row.pending_file_paths === "string"
          ? JSON.parse(row.pending_file_paths)
          : row.pending_file_paths || [],
      failedFilePaths:
        typeof row.failed_file_paths === "string"
          ? JSON.parse(row.failed_file_paths)
          : row.failed_file_paths || [],
      partialFiles:
        typeof row.partial_files === "string"
          ? JSON.parse(row.partial_files)
          : row.partial_files || [],
      manifest:
        typeof row.manifest === "string"
          ? JSON.parse(row.manifest)
          : row.manifest || [],
      result:
        typeof row.result === "string"
          ? JSON.parse(row.result)
          : row.result || undefined,
      error: row.error || undefined,
      statusCode: row.status_code ? Number(row.status_code) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      version: Number(row.version || 1),
      resumeLockWorker: row.resume_lock_worker || undefined,
      resumeLockExpiresAt: row.resume_lock_expires_at ? Number(row.resume_lock_expires_at) : undefined,
    };
  }

  public async createJob(
    id: string,
    prompt: string,
    provider: string,
    model: string,
    initialFiles: GeneratedFile[] = [],
    initialManifest: PlannedFile[] = []
  ): Promise<GenerationJob> {
    await this.ensureInitialized();
    const now = Date.now();
    const expiresAt = now + this.ttlMs;

    const job: GenerationJob = {
      id,
      prompt,
      provider,
      model,
      status: "pending",
      stageMessage: "Initializing application generation...",
      progressPercent: 5,
      completedFilePaths: initialFiles.map((f) => f.path),
      pendingFilePaths: [],
      failedFilePaths: [],
      partialFiles: [...initialFiles],
      manifest: [...initialManifest],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    try {
      await this.pool.query(
        `INSERT INTO generation_jobs (
          id, prompt, provider, model, status, stage_message,
          progress_percent, completed_file_paths, pending_file_paths,
          failed_file_paths, partial_files, manifest, created_at,
          updated_at, expires_at, version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          stage_message = EXCLUDED.stage_message,
          progress_percent = EXCLUDED.progress_percent,
          completed_file_paths = EXCLUDED.completed_file_paths,
          partial_files = EXCLUDED.partial_files,
          manifest = EXCLUDED.manifest,
          updated_at = EXCLUDED.updated_at,
          expires_at = EXCLUDED.expires_at,
          version = generation_jobs.version + 1`,
        [
          id,
          prompt,
          provider,
          model,
          job.status,
          job.stageMessage,
          job.progressPercent,
          JSON.stringify(job.completedFilePaths),
          JSON.stringify(job.pendingFilePaths),
          JSON.stringify(job.failedFilePaths),
          JSON.stringify(job.partialFiles),
          JSON.stringify(job.manifest),
          now,
          now,
          expiresAt,
        ]
      );
      return job;
    } catch (err) {
      const safe = sanitizeErrorMessage(err instanceof Error ? err.message : "Failed to persist job.");
      throw new Error(`Database error: ${safe}`);
    }
  }

  public async getJob(id: string): Promise<GenerationJob | undefined> {
    await this.ensureInitialized();
    const now = Date.now();
    try {
      const res = await this.pool.query(
        `SELECT * FROM generation_jobs WHERE id = $1 AND expires_at > $2`,
        [id, now]
      );
      if (res.rows.length === 0) {
        return undefined;
      }

      let job = this.mapRowToJob(res.rows[0]);

      // Check if job was interrupted by a server restart or timeout
      const isActive = job.status !== "completed" && job.status !== "failed";
      const isOverMaxDuration = now - job.createdAt > MAX_JOB_ACTIVE_DURATION_MS;
      const isStale = now - job.updatedAt > this.staleJobThresholdMs;

      if (isActive && (isOverMaxDuration || isStale)) {
        const errorMsg = isOverMaxDuration
          ? "Generation job exceeded maximum execution time (10m). Upstream model took too long to complete."
          : `Generation job was interrupted by a server restart. Preserved ${job.partialFiles?.length || 0} generated files. Use resumeJobId to continue generating remaining ${job.pendingFilePaths?.length || 0} files.`;

        job = (await this.failJob(id, errorMsg, 504)) || job;
      }

      return job;
    } catch (err) {
      const safe = sanitizeErrorMessage(err instanceof Error ? err.message : "Failed to retrieve job.");
      throw new Error(`Database error: ${safe}`);
    }
  }

  public async updateJobProgress(
    id: string,
    updates: {
      status?: GenerationJobStatus;
      stageMessage?: string;
      progressPercent?: number;
      completedFilePaths?: string[];
      pendingFilePaths?: string[];
      failedFilePaths?: string[];
      partialFiles?: GeneratedFile[];
      manifest?: PlannedFile[];
    }
  ): Promise<GenerationJob | undefined> {
    await this.ensureInitialized();
    const current = await this.getJob(id);
    if (!current) return undefined;

    const now = Date.now();
    let updatedPartialFiles = current.partialFiles || [];
    if (updates.partialFiles && updates.partialFiles.length > 0) {
      updatedPartialFiles = mergeJobFiles(updatedPartialFiles, updates.partialFiles);
    }

    const updatedCompleted = Array.from(
      new Set([
        ...current.completedFilePaths,
        ...(updates.completedFilePaths || []),
        ...updatedPartialFiles.map((f) => f.path),
      ])
    );

    let updatedPending = updates.pendingFilePaths
      ? Array.from(new Set(updates.pendingFilePaths.filter((p) => !updatedCompleted.includes(p))))
      : (current.pendingFilePaths || []).filter((p) => !updatedCompleted.includes(p));

    const updatedFailed = Array.from(
      new Set([...(current.failedFilePaths || []), ...(updates.failedFilePaths || [])])
    );
    updatedPending = updatedPending.filter((p) => !updatedFailed.includes(p));

    const updatedManifest =
      updates.manifest && updates.manifest.length > 0
        ? updates.manifest
        : current.manifest || [];

    const updatedStatus = updates.status || current.status;
    const updatedStage = updates.stageMessage || current.stageMessage;
    const updatedProgress =
      typeof updates.progressPercent === "number"
        ? Math.max(0, Math.min(100, updates.progressPercent))
        : current.progressPercent;

    try {
      await this.pool.query(
        `UPDATE generation_jobs SET
          status = $1,
          stage_message = $2,
          progress_percent = $3,
          completed_file_paths = $4,
          pending_file_paths = $5,
          failed_file_paths = $6,
          partial_files = $7,
          manifest = $8,
          updated_at = $9,
          version = version + 1
        WHERE id = $10`,
        [
          updatedStatus,
          updatedStage,
          updatedProgress,
          JSON.stringify(updatedCompleted),
          JSON.stringify(updatedPending),
          JSON.stringify(updatedFailed),
          JSON.stringify(updatedPartialFiles),
          JSON.stringify(updatedManifest),
          now,
          id,
        ]
      );

      return {
        ...current,
        status: updatedStatus,
        stageMessage: updatedStage,
        progressPercent: updatedProgress,
        completedFilePaths: updatedCompleted,
        pendingFilePaths: updatedPending,
        failedFilePaths: updatedFailed,
        partialFiles: updatedPartialFiles,
        manifest: updatedManifest,
        updatedAt: now,
        version: (current.version || 1) + 1,
      };
    } catch (err) {
      const safe = sanitizeErrorMessage(err instanceof Error ? err.message : "Failed to update job progress.");
      throw new Error(`Database error: ${safe}`);
    }
  }

  public async completeJob(
    id: string,
    result: GenerationJobResult
  ): Promise<GenerationJob | undefined> {
    await this.ensureInitialized();
    const current = await this.getJob(id);
    if (!current) return undefined;

    const now = Date.now();
    const completedPaths = result.files.map((f) => f.path);

    try {
      await this.pool.query(
        `UPDATE generation_jobs SET
          status = 'completed',
          stage_message = 'Application generation completed successfully.',
          progress_percent = 100,
          completed_file_paths = $1,
          pending_file_paths = '[]'::jsonb,
          partial_files = $2,
          result = $3,
          updated_at = $4,
          version = version + 1
        WHERE id = $5`,
        [
          JSON.stringify(completedPaths),
          JSON.stringify(result.files),
          JSON.stringify(result),
          now,
          id,
        ]
      );

      return {
        ...current,
        status: "completed",
        stageMessage: "Application generation completed successfully.",
        progressPercent: 100,
        completedFilePaths: completedPaths,
        pendingFilePaths: [],
        partialFiles: result.files,
        result,
        updatedAt: now,
        version: (current.version || 1) + 1,
      };
    } catch (err) {
      const safe = sanitizeErrorMessage(err instanceof Error ? err.message : "Failed to complete job.");
      throw new Error(`Database error: ${safe}`);
    }
  }

  public async failJob(
    id: string,
    error: string,
    statusCode: number = 502
  ): Promise<GenerationJob | undefined> {
    await this.ensureInitialized();
    const now = Date.now();
    try {
      const res = await this.pool.query(
        `UPDATE generation_jobs SET
          status = 'failed',
          stage_message = $1,
          error = $2,
          status_code = $3,
          updated_at = $4,
          version = version + 1
        WHERE id = $5
        RETURNING *`,
        [`Generation failed: ${error}`, error, statusCode, now, id]
      );

      if (res.rows.length === 0) return undefined;
      return this.mapRowToJob(res.rows[0]);
    } catch (err) {
      const safe = sanitizeErrorMessage(err instanceof Error ? err.message : "Failed to record job failure.");
      throw new Error(`Database error: ${safe}`);
    }
  }

  public async acquireResumeLock(
    id: string,
    workerId: string,
    ttlMs: number = this.resumeLockTtlMs
  ): Promise<boolean> {
    await this.ensureInitialized();
    const now = Date.now();
    const expiresAt = now + ttlMs;

    try {
      const res = await this.pool.query(
        `UPDATE generation_jobs SET
          resume_lock_worker = $1,
          resume_lock_expires_at = $2,
          updated_at = $3,
          version = version + 1
        WHERE id = $4
          AND (resume_lock_worker IS NULL OR resume_lock_expires_at < $3)`,
        [workerId, expiresAt, now, id]
      );

      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      const safe = sanitizeErrorMessage(err instanceof Error ? err.message : "Failed to acquire resume lock.");
      throw new Error(`Database error: ${safe}`);
    }
  }

  public async releaseResumeLock(id: string, workerId: string): Promise<void> {
    await this.ensureInitialized();
    const now = Date.now();
    try {
      await this.pool.query(
        `UPDATE generation_jobs SET
          resume_lock_worker = NULL,
          resume_lock_expires_at = NULL,
          updated_at = $1,
          version = version + 1
        WHERE id = $2 AND resume_lock_worker = $3`,
        [now, id, workerId]
      );
    } catch (err) {
      const safe = sanitizeErrorMessage(err instanceof Error ? err.message : "Failed to release resume lock.");
      throw new Error(`Database error: ${safe}`);
    }
  }

  public async touchJob(id: string, workerId?: string, ttlMs?: number): Promise<boolean> {
    await this.ensureInitialized();
    const now = Date.now();
    const lockTtl = ttlMs ?? this.resumeLockTtlMs;
    const expiresAt = now + lockTtl;

    try {
      if (workerId) {
        const res = await this.pool.query(
          `UPDATE generation_jobs SET
            updated_at = $1,
            resume_lock_worker = $2,
            resume_lock_expires_at = $3,
            version = version + 1
          WHERE id = $4
            AND (resume_lock_worker = $2 OR resume_lock_worker IS NULL OR resume_lock_expires_at < $1)`,
          [now, workerId, expiresAt, id]
        );
        return (res.rowCount ?? 0) > 0;
      } else {
        const res = await this.pool.query(
          `UPDATE generation_jobs SET
            updated_at = $1,
            version = version + 1
          WHERE id = $2`,
          [now, id]
        );
        return (res.rowCount ?? 0) > 0;
      }
    } catch (err) {
      const safe = sanitizeErrorMessage(err instanceof Error ? err.message : "Failed to touch job.");
      throw new Error(`Database error: ${safe}`);
    }
  }

  public async renewResumeLock(id: string, workerId: string, ttlMs?: number): Promise<boolean> {
    return this.touchJob(id, workerId, ttlMs);
  }

  public async cleanupExpiredJobs(): Promise<number> {
    await this.ensureInitialized();
    const now = Date.now();
    try {
      const res = await this.pool.query(
        `DELETE FROM generation_jobs WHERE expires_at <= $1`,
        [now]
      );
      return res.rowCount ?? 0;
    } catch (err) {
      const safe = sanitizeErrorMessage(err instanceof Error ? err.message : "Failed to cleanup expired jobs.");
      throw new Error(`Database error: ${safe}`);
    }
  }

  public async clear(): Promise<void> {
    await this.ensureInitialized();
    try {
      await this.pool.query(`TRUNCATE TABLE generation_jobs;`);
    } catch (err) {
      const safe = sanitizeErrorMessage(err instanceof Error ? err.message : "Failed to truncate generation_jobs.");
      throw new Error(`Database error: ${safe}`);
    }
  }

  public async close(): Promise<void> {
    if (!this.isExternalPool && this.pool && typeof (this.pool as Pool).end === "function") {
      await (this.pool as Pool).end();
    }
  }
}

// -----------------------------------------------------------------------------
// Generation Job Store Manager (Unified Singleton Interface)
// -----------------------------------------------------------------------------
export class GenerationJobStoreManager implements IGenerationJobStore {
  private activeStore: IGenerationJobStore;
  private memoryCache = new Map<string, GenerationJob>();

  constructor(store?: IGenerationJobStore) {
    this.activeStore = store || this.resolveStore();
  }

  private resolveStore(): IGenerationJobStore {
    const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    const isProd = process.env.NODE_ENV === "production";
    const isBuildPhase =
      process.env.NEXT_PHASE === "phase-production-build" ||
      process.env.NEXT_PHASE === "phase-export" ||
      process.env.__NEXT_BUILDING_STATIC === "1" ||
      Boolean(process.env.NEXT_PRIVATE_BUILD_WORKER);

    if (dbUrl) {
      try {
        return new PostgresJobStore();
      } catch (err) {
        if (isProd && !isBuildPhase) {
          throw err;
        }
        console.warn("[JobStore] Failed to initialize PostgresJobStore, falling back to MemoryJobStore for dev/test:", err);
        return new MemoryJobStore();
      }
    }

    if (isProd && !isBuildPhase) {
      throw new Error(
        "Production database configuration missing: Set DATABASE_URL or POSTGRES_URL to enable durable multi-instance generation job persistence."
      );
    }

    return new MemoryJobStore();
  }

  public setActiveStore(store: IGenerationJobStore): void {
    this.activeStore = store;
  }

  public getActiveStore(): IGenerationJobStore {
    return this.activeStore;
  }

  public getJob(id: string): GenerationJob | undefined {
    const storeRes = this.activeStore.getJob(id);
    if (storeRes && typeof (storeRes as Promise<any>).then !== "function") {
      const job = storeRes as GenerationJob;
      this.memoryCache.set(id, job);
      return job;
    }
    const cached = this.memoryCache.get(id);
    if (cached) {
      const now = Date.now();
      const isActive = cached.status !== "completed" && cached.status !== "failed";
      const isOverMaxDuration = now - cached.createdAt > MAX_JOB_ACTIVE_DURATION_MS;
      if (isActive && isOverMaxDuration) {
        cached.status = "failed";
        cached.statusCode = 504;
        cached.error = "Generation job exceeded maximum execution time (10m). Upstream model took too long to complete.";
      }
      return cached;
    }
    return undefined;
  }

  public async getJobAsync(id: string): Promise<GenerationJob | undefined> {
    const job = await this.activeStore.getJob(id);
    if (job) {
      this.memoryCache.set(id, job);
    } else {
      this.memoryCache.delete(id);
    }
    return job;
  }

  public createJob(
    id: string,
    prompt: string,
    provider: string,
    model: string,
    initialFiles: GeneratedFile[] = [],
    initialManifest: PlannedFile[] = []
  ): GenerationJob {
    const now = Date.now();
    const job: GenerationJob = {
      id,
      prompt,
      provider,
      model,
      status: "pending",
      stageMessage: "Initializing application generation...",
      progressPercent: 5,
      completedFilePaths: initialFiles.map((f) => f.path),
      pendingFilePaths: [],
      failedFilePaths: [],
      partialFiles: [...initialFiles],
      manifest: [...initialManifest],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    const storeRes = this.activeStore.createJob(id, prompt, provider, model, initialFiles, initialManifest);
    if (storeRes && typeof (storeRes as Promise<any>).then !== "function") {
      const activeJob = storeRes as GenerationJob;
      this.memoryCache.set(id, activeJob);
      return activeJob;
    }
    this.memoryCache.set(id, job);
    if (storeRes && typeof (storeRes as Promise<any>).catch === "function") {
      (storeRes as Promise<any>).catch((err) => {
        console.warn(`[JobStore] Background persistence error for job ${id}:`, err);
      });
    }
    return job;
  }

  public async createJobAsync(
    id: string,
    prompt: string,
    provider: string,
    model: string,
    initialFiles: GeneratedFile[] = [],
    initialManifest: PlannedFile[] = []
  ): Promise<GenerationJob> {
    const job = await this.activeStore.createJob(id, prompt, provider, model, initialFiles, initialManifest);
    this.memoryCache.set(id, job);
    return job;
  }

  public updateJobProgress(
    id: string,
    updates: {
      status?: GenerationJobStatus;
      stageMessage?: string;
      progressPercent?: number;
      completedFilePaths?: string[];
      pendingFilePaths?: string[];
      failedFilePaths?: string[];
      partialFiles?: GeneratedFile[];
      manifest?: PlannedFile[];
    }
  ): GenerationJob | undefined {
    const job = this.memoryCache.get(id);
    if (job) {
      if (updates.status) job.status = updates.status;
      if (updates.stageMessage) job.stageMessage = updates.stageMessage;
      if (typeof updates.progressPercent === "number") {
        job.progressPercent = Math.max(0, Math.min(100, updates.progressPercent));
      }
      if (updates.manifest && updates.manifest.length > 0) {
        job.manifest = updates.manifest;
      }
      if (updates.partialFiles && updates.partialFiles.length > 0) {
        job.partialFiles = mergeJobFiles(job.partialFiles || [], updates.partialFiles);
        const partialPaths = job.partialFiles.map((f) => f.path);
        job.completedFilePaths = Array.from(new Set([...job.completedFilePaths, ...partialPaths]));
      }
      if (updates.completedFilePaths) {
        job.completedFilePaths = Array.from(new Set([...job.completedFilePaths, ...updates.completedFilePaths]));
        if (job.pendingFilePaths) {
          job.pendingFilePaths = job.pendingFilePaths.filter((p) => !job.completedFilePaths.includes(p));
        }
      }
      if (updates.pendingFilePaths) {
        const activeCompleted = new Set(job.completedFilePaths);
        job.pendingFilePaths = Array.from(
          new Set(updates.pendingFilePaths.filter((p) => !activeCompleted.has(p)))
        );
      }
      if (updates.failedFilePaths) {
        job.failedFilePaths = Array.from(new Set([...(job.failedFilePaths || []), ...updates.failedFilePaths]));
        if (job.pendingFilePaths) {
          job.pendingFilePaths = job.pendingFilePaths.filter((p) => !job.failedFilePaths?.includes(p));
        }
      }
      job.version = (job.version || 1) + 1;
      job.updatedAt = Date.now();
      this.memoryCache.set(id, job);
    }

    const storeRes = this.activeStore.updateJobProgress(id, updates);
    if (storeRes && typeof (storeRes as Promise<any>).then !== "function") {
      const activeJob = storeRes as GenerationJob;
      this.memoryCache.set(id, activeJob);
      return activeJob;
    }
    if (storeRes && typeof (storeRes as Promise<any>).catch === "function") {
      (storeRes as Promise<any>).catch((err) => {
        console.warn(`[JobStore] Background update error for job ${id}:`, err);
      });
    }
    return job;
  }

  public async updateJobProgressAsync(
    id: string,
    updates: {
      status?: GenerationJobStatus;
      stageMessage?: string;
      progressPercent?: number;
      completedFilePaths?: string[];
      pendingFilePaths?: string[];
      failedFilePaths?: string[];
      partialFiles?: GeneratedFile[];
      manifest?: PlannedFile[];
    }
  ): Promise<GenerationJob | undefined> {
    const job = await this.activeStore.updateJobProgress(id, updates);
    if (job) {
      this.memoryCache.set(id, job);
    }
    return job;
  }

  public completeJob(id: string, result: GenerationJobResult): GenerationJob | undefined {
    const job = this.memoryCache.get(id);
    if (job) {
      job.status = "completed";
      job.stageMessage = "Application generation completed successfully.";
      job.progressPercent = 100;
      job.completedFilePaths = result.files.map((f) => f.path);
      job.pendingFilePaths = [];
      job.partialFiles = result.files;
      job.result = result;
      job.version = (job.version || 1) + 1;
      job.updatedAt = Date.now();
      this.memoryCache.set(id, job);
    }

    const storeRes = this.activeStore.completeJob(id, result);
    if (storeRes && typeof (storeRes as Promise<any>).then !== "function") {
      const activeJob = storeRes as GenerationJob;
      this.memoryCache.set(id, activeJob);
      return activeJob;
    }
    if (storeRes && typeof (storeRes as Promise<any>).catch === "function") {
      (storeRes as Promise<any>).catch((err) => {
        console.warn(`[JobStore] Background completion error for job ${id}:`, err);
      });
    }
    return job;
  }

  public async completeJobAsync(id: string, result: GenerationJobResult): Promise<GenerationJob | undefined> {
    const job = await this.activeStore.completeJob(id, result);
    if (job) {
      this.memoryCache.set(id, job);
    }
    return job;
  }

  public failJob(id: string, error: string, statusCode: number = 502): GenerationJob | undefined {
    const job = this.memoryCache.get(id);
    if (job) {
      job.status = "failed";
      job.stageMessage = `Generation failed: ${error}`;
      job.error = error;
      job.statusCode = statusCode;
      job.version = (job.version || 1) + 1;
      job.updatedAt = Date.now();
      this.memoryCache.set(id, job);
    }

    const storeRes = this.activeStore.failJob(id, error, statusCode);
    if (storeRes && typeof (storeRes as Promise<any>).then !== "function") {
      const activeJob = storeRes as GenerationJob;
      this.memoryCache.set(id, activeJob);
      return activeJob;
    }
    if (storeRes && typeof (storeRes as Promise<any>).catch === "function") {
      (storeRes as Promise<any>).catch((err) => {
        console.warn(`[JobStore] Background failure error for job ${id}:`, err);
      });
    }
    return job;
  }

  public async failJobAsync(id: string, error: string, statusCode: number = 502): Promise<GenerationJob | undefined> {
    const job = await this.activeStore.failJob(id, error, statusCode);
    if (job) {
      this.memoryCache.set(id, job);
    }
    return job;
  }

  public async acquireResumeLock(id: string, workerId: string, ttlMs?: number): Promise<boolean> {
    return this.activeStore.acquireResumeLock(id, workerId, ttlMs);
  }

  public async releaseResumeLock(id: string, workerId: string): Promise<void> {
    return this.activeStore.releaseResumeLock(id, workerId);
  }

  public async touchJob(id: string, workerId?: string, ttlMs?: number): Promise<boolean> {
    const cached = this.memoryCache.get(id);
    const now = Date.now();
    if (cached) {
      cached.updatedAt = now;
      if (workerId) {
        cached.resumeLockWorker = workerId;
        cached.resumeLockExpiresAt = now + (ttlMs ?? DEFAULT_RESUME_LOCK_TTL_MS);
      }
    }
    if (typeof this.activeStore.touchJob === "function") {
      return this.activeStore.touchJob(id, workerId, ttlMs);
    }
    return true;
  }

  public async renewResumeLock(id: string, workerId: string, ttlMs?: number): Promise<boolean> {
    return this.touchJob(id, workerId, ttlMs);
  }

  public async cleanupExpiredJobs(): Promise<number> {
    return this.activeStore.cleanupExpiredJobs();
  }

  public clear(): void {
    this.memoryCache.clear();
    const storeRes = this.activeStore.clear();
    if (storeRes && typeof (storeRes as Promise<any>).catch === "function") {
      (storeRes as Promise<any>).catch(() => {});
    }
  }

  public async clearAsync(): Promise<void> {
    this.memoryCache.clear();
    await this.activeStore.clear();
  }
}

// Backward-compatible alias
export { MemoryJobStore as GenerationJobStore };

declare global {
  var __metaAiGenerationJobStore: GenerationJobStoreManager | undefined;
}

export const globalJobStore =
  globalThis.__metaAiGenerationJobStore ??
  (globalThis.__metaAiGenerationJobStore = new GenerationJobStoreManager());

// -----------------------------------------------------------------------------
// Active Job Heartbeat & Resume-Lock Renewal
// -----------------------------------------------------------------------------
export interface JobHeartbeatHandle {
  stop: () => void;
  renewNow: () => Promise<void>;
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 1000; // 15 seconds

export function startJobHeartbeat(
  jobIds: string | string[],
  workerId: string,
  options?: {
    store?: IGenerationJobStore;
    intervalMs?: number;
    lockTtlMs?: number;
    onError?: (err: unknown) => void;
  }
): JobHeartbeatHandle {
  const rawIds = Array.isArray(jobIds) ? jobIds : [jobIds];
  const ids = Array.from(new Set(rawIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)));
  const targetStore = options?.store || globalJobStore;
  const intervalMs = options?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const lockTtlMs = options?.lockTtlMs ?? DEFAULT_RESUME_LOCK_TTL_MS;

  let stopped = false;

  const renewAll = async () => {
    if (stopped || ids.length === 0) return;
    try {
      await Promise.all(
        ids.map((id) =>
          typeof targetStore.touchJob === "function"
            ? targetStore.touchJob(id, workerId, lockTtlMs)
            : Promise.resolve(true)
        )
      );
    } catch (err) {
      if (!stopped && options?.onError) {
        options.onError(err);
      }
    }
  };

  const timer = setInterval(() => {
    void renewAll();
  }, intervalMs);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    renewNow: renewAll,
  };
}
