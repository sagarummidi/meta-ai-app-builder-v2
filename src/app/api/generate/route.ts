import { NextResponse } from "next/server";
import {
  modelRouter,
  AVAILABLE_PROVIDERS,
  getErrorStatusCode,
  sanitizeErrorMessage,
  DEFAULT_PROVIDER_TIMEOUT_MS,
} from "@/lib/modelRouter";
import {
  enforceRouteRateLimit,
  defaultConcurrencyLimiter,
  type IRateLimiter,
  type ConcurrencyLimiter,
} from "@/lib/rateLimiter";
import {
  executeGenerationPipeline,
  executeStagedGenerationPipeline,
} from "@/lib/jsonRecovery";
import { globalJobStore, type GenerationJobStatus } from "@/lib/generationJobs";

export const maxDuration = 600;
export const dynamic = "force-dynamic";

const MAX_PROMPT_LENGTH = 15000;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");

  if (!jobId || !jobId.trim()) {
    return NextResponse.json(
      { success: false, message: "Missing required 'jobId' parameter." },
      { status: 400 }
    );
  }

  const job = globalJobStore.getJob(jobId.trim());
  if (!job) {
    return NextResponse.json(
      {
        success: false,
        message: "Generation job not found or has expired.",
      },
      { status: 404 }
    );
  }

  if (job.status === "failed") {
    return NextResponse.json(
      {
        success: false,
        jobId: job.id,
        status: job.status,
        stageMessage: job.stageMessage,
        error: job.error,
        message: job.error || "Generation job failed.",
        completedFilePaths: job.completedFilePaths,
      },
      { status: job.statusCode || 502 }
    );
  }

  if (job.status === "completed" && job.result) {
    return NextResponse.json({
      success: true,
      jobId: job.id,
      status: job.status,
      stageMessage: job.stageMessage,
      progressPercent: 100,
      completedFilePaths: job.completedFilePaths,
      prompt: job.prompt,
      generatedCode: job.result.generatedCode,
      files: job.result.files,
      dependencies: job.result.dependencies,
      usedModel: job.result.usedModel,
      usedProvider: job.result.usedProvider,
      fallbackUsed: job.result.fallbackUsed,
      fallbackNotice: job.result.fallbackNotice,
      timings: job.result.timings,
    });
  }

  return NextResponse.json({
    success: true,
    jobId: job.id,
    status: job.status,
    stageMessage: job.stageMessage,
    progressPercent: job.progressPercent,
    completedFilePaths: job.completedFilePaths,
  });
}

export async function POST(request: Request, context?: unknown) {
  const serverReqId = Math.random().toString(36).substring(2, 10);
  const startTime = Date.now();

  const injectedRateLimiter = (context as { rateLimiter?: IRateLimiter })?.rateLimiter;
  const injectedConcurrencyLimiter = (context as { concurrencyLimiter?: ConcurrencyLimiter })
    ?.concurrencyLimiter;

  const rateLimitCheck = await enforceRouteRateLimit(request, "generate", {
    limiter: injectedRateLimiter,
    requestId: serverReqId,
  });

  if (!rateLimitCheck.allowed) {
    return rateLimitCheck.response;
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        requestId: serverReqId,
        message: "Invalid JSON request body.",
      },
      { status: 400 }
    );
  }

  try {
    const rawPrompt = typeof body?.prompt === "string" ? body.prompt : "";
    const prompt = rawPrompt.trim();
    const reqId = typeof body?.requestId === "string" && body.requestId.trim() ? body.requestId.trim() : serverReqId;

    const rawProvider =
      typeof body?.provider === "string" && body.provider.trim()
        ? body.provider.trim()
        : process.env.AI_PROVIDER || "meta";
    console.log(`[Req ${reqId}] POST /api/generate received prompt length: ${prompt.length}, raw provider: ${rawProvider}`);

    if (!prompt) {
      console.log(`[Req ${reqId}] Rejected: empty prompt`);
      return NextResponse.json(
        {
          success: false,
          requestId: reqId,
          message: "Please provide a prompt.",
        },
        { status: 400 }
      );
    }

    if (prompt.length > MAX_PROMPT_LENGTH) {
      console.log(`[Req ${reqId}] Rejected: excessively large prompt (${prompt.length} chars)`);
      return NextResponse.json(
        {
          success: false,
          requestId: reqId,
          message: `Prompt exceeds maximum allowed length of ${MAX_PROMPT_LENGTH.toLocaleString()} characters.`,
        },
        { status: 400 }
      );
    }

    const providerConfig = AVAILABLE_PROVIDERS.find((p) => p.provider === rawProvider);
    if (!providerConfig) {
      console.error(`[Req ${reqId}] Error: Provider '${rawProvider}' is not available or registered.`);
      return NextResponse.json(
        {
          success: false,
          requestId: reqId,
          message: `Selected provider '${rawProvider}' is not available or registered.`,
        },
        { status: 400 }
      );
    }

    const providerType = providerConfig.provider;
    const requestedModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    const modelToUse = requestedModel || providerConfig.models.find((m) => m.isDefault)?.id || providerConfig.models[0]?.id || "";

    const isModelValid = providerConfig.models.some((m) => m.id === modelToUse);
    if (!isModelValid) {
      console.error(`[Req ${reqId}] Error: Model '${modelToUse}' is not available for provider '${providerType}'.`);
      return NextResponse.json(
        {
          success: false,
          requestId: reqId,
          message: `Selected model '${modelToUse}' is not available for provider '${providerType}'.`,
        },
        { status: 400 }
      );
    }

    const activeConcurrencyLimiter = injectedConcurrencyLimiter || defaultConcurrencyLimiter;
    const rawMode = typeof body.mode === "string" ? body.mode.trim().toLowerCase() : "";
    const requestedTimeoutMs =
      typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs) && body.timeoutMs > 0
        ? Math.min(body.timeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS)
        : undefined;
    const isAsyncMode = rawMode === "async" || (rawMode !== "sync" && process.env.NODE_ENV !== "test");

    if (isAsyncMode) {
      const job = globalJobStore.createJob(reqId, prompt, providerType, modelToUse);

      (async () => {
        try {
          globalJobStore.updateJobProgress(reqId, {
            status: "planning",
            stageMessage: "Planning application architecture...",
            progressPercent: 10,
          });

          const pipelineResult = await executeStagedGenerationPipeline({
            modelRouter,
            provider: providerType,
            model: modelToUse,
            userPrompt: prompt,
            requestId: reqId,
            disableFallback: true,
            concurrencyLimiter: activeConcurrencyLimiter,
            timeoutMs: requestedTimeoutMs,
            onProgress: (stageMessage: string, progressPercent: number, completedFiles: { path: string }[], stageStatus?: GenerationJobStatus) => {
              globalJobStore.updateJobProgress(reqId, {
                status: stageStatus || "generating_components",
                stageMessage,
                progressPercent,
                completedFilePaths: completedFiles.map((f) => f.path),
              });
            },
          });

          const validFiles = pipelineResult.files;
          const mainFile =
            validFiles.find(
              (file) => file.path === "App.tsx" || file.path.endsWith("/App.tsx")
            ) ||
            validFiles.find((file) => file.path === "page.tsx") ||
            validFiles[0];

          globalJobStore.completeJob(reqId, {
            files: validFiles,
            dependencies: pipelineResult.dependencies,
            generatedCode: mainFile?.code || "",
            usedModel: pipelineResult.usedModel,
            usedProvider: pipelineResult.usedProvider,
            fallbackUsed: pipelineResult.fallbackUsed,
            fallbackNotice: pipelineResult.fallbackNotice,
            timings: pipelineResult.timings,
          });
        } catch (jobErr) {
          const statusCode = getErrorStatusCode(jobErr);
          const rawMessage = jobErr instanceof Error ? jobErr.message : "Unknown generation error.";
          const safeMessage = sanitizeErrorMessage(rawMessage);
          globalJobStore.failJob(reqId, safeMessage, statusCode);
        }
      })().catch((unhandledErr) => {
        const statusCode = getErrorStatusCode(unhandledErr);
        const rawMessage = unhandledErr instanceof Error ? unhandledErr.message : "Unexpected background task failure.";
        globalJobStore.failJob(reqId, sanitizeErrorMessage(rawMessage), statusCode);
      });

      return NextResponse.json({
        success: true,
        requestId: reqId,
        jobId: job.id,
        status: "pending",
        message: "Application generation job started",
      });
    }

    console.log(`[Req ${reqId}] Calling ModelRouter (${providerType}, model: ${modelToUse}) with recovery pipeline (sync mode)...`);

    const pipelineResult = await executeGenerationPipeline({
      modelRouter,
      provider: providerType,
      model: modelToUse,
      userPrompt: prompt,
      requestId: reqId,
      disableFallback: true,
      maxContinuationAttempts: 2,
      concurrencyLimiter: activeConcurrencyLimiter,
    });

    const validFiles = pipelineResult.files;
    const mainFile =
      validFiles.find(
        (file) =>
          file.path === "App.tsx" ||
          file.path.endsWith("/App.tsx")
      ) ||
      validFiles.find((file) => file.path === "page.tsx") ||
      validFiles[0];

    const totalDuration = Date.now() - startTime;
    console.log(
      `[Req ${reqId}] Request successfully completed in ${totalDuration}ms (Attempts: ${pipelineResult.attemptsUsed})`
    );

    return NextResponse.json({
      success: true,
      requestId: reqId,
      prompt,
      generatedCode: mainFile?.code || "",
      files: validFiles,
      dependencies: pipelineResult.dependencies,
      usedModel: pipelineResult.usedModel,
      usedProvider: pipelineResult.usedProvider,
      fallbackUsed: pipelineResult.fallbackUsed,
      fallbackNotice: pipelineResult.fallbackNotice,
      timings: pipelineResult.timings,
    });
  } catch (error) {
    const totalDuration = Date.now() - startTime;
    console.error(`[Req ${serverReqId}] API error after ${totalDuration}ms:`, error);

    const statusCode = getErrorStatusCode(error);
    const rawMessage = error instanceof Error ? error.message : "Unknown generation error.";
    const safeMessage = sanitizeErrorMessage(rawMessage);

    const headers: Record<string, string> = {};
    if (statusCode === 429) {
      const retryAfter =
        (error as { retryAfter?: number })?.retryAfter ??
        (error as { retryAfterSeconds?: number })?.retryAfterSeconds ??
        5;
      headers["Retry-After"] = String(retryAfter);
    }

    return NextResponse.json(
      {
        success: false,
        requestId: serverReqId,
        message: safeMessage,
      },
      { status: statusCode, headers }
    );
  }
}
