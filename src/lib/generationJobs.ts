import type { GeneratedFile, PipelineTimingInfo } from "./jsonRecovery";

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
  createdAt: number;
  updatedAt: number;
  result?: GenerationJobResult;
  error?: string;
  statusCode?: number;
}

const JOB_TTL_MS = 15 * 60 * 1000; // 15 minutes TTL for jobs in memory
const MAX_JOBS_STORED = 200;
export const MAX_GENERATION_DURATION_MS = 10 * 60 * 1000; // 10 minutes (600,000 ms)
export const MAX_JOB_CLEANUP_GRACE_PERIOD_MS = 30 * 1000; // 30 seconds grace period
export const MAX_JOB_ACTIVE_DURATION_MS =
  MAX_GENERATION_DURATION_MS + MAX_JOB_CLEANUP_GRACE_PERIOD_MS; // 630,000 ms (10.5 minutes)

class GenerationJobStore {
  private jobs = new Map<string, GenerationJob>();

  public createJob(
    id: string,
    prompt: string,
    provider: string,
    model: string
  ): GenerationJob {
    this.cleanupOldJobs();

    const now = Date.now();
    const job: GenerationJob = {
      id,
      prompt,
      provider,
      model,
      status: "pending",
      stageMessage: "Initializing application generation...",
      progressPercent: 5,
      completedFilePaths: [],
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(id, job);
    return job;
  }

  public getJob(id: string): GenerationJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;

    // Automatically transition to failed if active job exceeds maximum active duration
    if (
      job.status !== "completed" &&
      job.status !== "failed" &&
      Date.now() - job.createdAt > MAX_JOB_ACTIVE_DURATION_MS
    ) {
      this.failJob(
        id,
        "Generation job exceeded maximum execution time (10m). Upstream model took too long to complete.",
        504
      );
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
    }
  ): GenerationJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;

    if (updates.status) job.status = updates.status;
    if (updates.stageMessage) job.stageMessage = updates.stageMessage;
    if (typeof updates.progressPercent === "number") {
      job.progressPercent = Math.max(0, Math.min(100, updates.progressPercent));
    }
    if (updates.completedFilePaths) {
      job.completedFilePaths = Array.from(
        new Set([...job.completedFilePaths, ...updates.completedFilePaths])
      );
    }
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
    job.result = result;
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
    job.updatedAt = Date.now();
    return job;
  }

  public clear(): void {
    this.jobs.clear();
  }

  private cleanupOldJobs(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs.entries()) {
      if (now - job.createdAt > JOB_TTL_MS) {
        this.jobs.delete(id);
      }
    }

    if (this.jobs.size > MAX_JOBS_STORED) {
      const sorted = Array.from(this.jobs.entries()).sort(
        (a, b) => a[1].createdAt - b[1].createdAt
      );
      const toRemove = sorted.slice(0, this.jobs.size - MAX_JOBS_STORED);
      for (const [id] of toRemove) {
        this.jobs.delete(id);
      }
    }
  }
}

declare global {
  var __metaAiGenerationJobStore: GenerationJobStore | undefined;
}

export const globalJobStore =
  globalThis.__metaAiGenerationJobStore ??
  (globalThis.__metaAiGenerationJobStore = new GenerationJobStore());
