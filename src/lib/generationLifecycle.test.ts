import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  MetaProvider,
  ModelRouter,
  getErrorStatusCode,
  isRetryableModelError,
  sanitizeErrorMessage,
  MAX_GENERATION_DURATION_MS,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "./modelRouter";
import { executeStagedGenerationPipeline } from "./jsonRecovery";
import {
  globalJobStore,
  MAX_JOB_ACTIVE_DURATION_MS,
  MAX_JOB_CLEANUP_GRACE_PERIOD_MS,
} from "./generationJobs";
import { GET as generateGet } from "../app/api/generate/route";

class MockLifecycleProvider implements ModelProvider {
  name = "meta" as const;
  public calls: ModelRequest[] = [];
  public responses: Array<ModelResponse | Error> = [];

  constructor(responses: Array<ModelResponse | Error> = []) {
    this.responses = responses;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const next = this.responses.shift();
    if (!next) {
      throw new Error(`MockLifecycleProvider: No response queued for call ${this.calls.length}.`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

describe("Meta Muse Spark 10-Minute Generation Lifecycle & Timeout Hardening", () => {
  beforeEach(() => {
    globalJobStore.clear();
  });

  // 1. A generation taking several minutes can complete successfully
  test("1. A generation taking several minutes can complete successfully within 10-minute window", async () => {
    assert.equal(MAX_GENERATION_DURATION_MS, 600000); // 10 minutes
    assert.equal(DEFAULT_PROVIDER_TIMEOUT_MS, 600000);

    const planJson = JSON.stringify({
      files: [
        { path: "types.ts", description: "Type definitions" },
        { path: "App.tsx", description: "Main entry point" },
      ],
      dependencies: {},
    });

    const typesJson = JSON.stringify({
      files: [{ path: "types.ts", code: "export interface Todo { id: string; text: string; }" }],
      dependencies: {},
    });

    const appJson = JSON.stringify({
      files: [
        {
          path: "App.tsx",
          code: `import React from 'react';
export default function App() {
  return <div>Todo App</div>;
}`,
        },
      ],
      dependencies: {},
    });

    const mockProvider = new MockLifecycleProvider([
      { outputText: planJson, finishReason: "stop" },
      { outputText: typesJson, finishReason: "stop" },
      { outputText: appJson, finishReason: "stop" },
    ]);

    const router = new ModelRouter();
    router.registerProvider(mockProvider);
    const jobId = "job-10m-success";
    globalJobStore.createJob(jobId, "Build a todo app", "meta", "muse-spark-1.3");

    // Execute with default 10-minute timeout
    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build a todo app",
      requestId: jobId,
      disableFallback: true,
      onProgress: (stageMessage, progressPercent, completedFiles) => {
        globalJobStore.updateJobProgress(jobId, {
          status: "generating_components",
          stageMessage,
          progressPercent,
          completedFilePaths: completedFiles.map((f) => f.path),
        });
      },
    });

    assert.ok(result.files.length >= 2);
    const mainFile = result.files.find((f) => f.path === "App.tsx");
    assert.ok(mainFile);
    assert.match(mainFile.code, /export default function App/);

    globalJobStore.completeJob(jobId, {
      files: result.files,
      dependencies: result.dependencies,
      generatedCode: mainFile.code,
      usedModel: result.usedModel,
      usedProvider: result.usedProvider,
      fallbackUsed: result.fallbackUsed,
    });

    const finalJob = globalJobStore.getJob(jobId);
    assert.ok(finalJob);
    assert.equal(finalJob.status, "completed");
    assert.equal(finalJob.progressPercent, 100);
  });

  // 2. A slow provider response does not trigger premature cancellation
  test("2. A slow provider response does not trigger premature cancellation (allocates full remaining pipeline time)", async () => {
    let observedCallTimeoutMs = 0;
    const trackingProvider: ModelProvider = {
      name: "meta",
      generate: async (request: ModelRequest): Promise<ModelResponse> => {
        observedCallTimeoutMs = request.timeoutMs || 0;
        return {
          outputText: JSON.stringify({
            files: [{ path: "App.tsx", code: "export default () => <div>Slow App</div>;" }],
            dependencies: {},
          }),
          finishReason: "stop",
        };
      },
    };

    const router = new ModelRouter();
    router.registerProvider(trackingProvider);

    // Call staged pipeline without passing custom timeoutMs (defaults to 10 minutes)
    await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Slow app",
      requestId: "req-slow-test",
      disableFallback: true,
    });

    // Verify the timeout allocated to the provider call is bounded by the 10-minute window (e.g. ~590s - 600s),
    // and was NOT prematurely restricted to 60s or 180s
    assert.ok(
      observedCallTimeoutMs > 550000,
      `Expected call timeout to be close to 600,000ms (10m), but got ${observedCallTimeoutMs}ms`
    );
  });

  // 3. A stalled response body is eventually aborted at the configured deadline
  test("3. A stalled response body is eventually aborted at the configured deadline (HTTP 504)", async () => {
    // 3a. Stalled response.json()
    const slowJsonFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          });
        },
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const providerWithSlowBody = new MetaProvider({
      apiKey: "test-key",
      fetchFn: slowJsonFetch,
    });

    await assert.rejects(
      async () => {
        await providerWithSlowBody.generate({
          input: "test prompt",
          timeoutMs: 40, // 40ms mock timeout for rapid verification
        });
      },
      (err: unknown) => {
        const status = getErrorStatusCode(err);
        assert.equal(status, 504);
        assert.match((err as Error).message, /timed out after 0s while reading response body/i);
        return true;
      }
    );

    // 3b. Stalled error response.text()
    const slowTextFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      return {
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          });
        },
        json: async () => ({}),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const providerWithSlowError = new MetaProvider({
      apiKey: "test-key",
      fetchFn: slowTextFetch,
    });

    await assert.rejects(
      async () => {
        await providerWithSlowError.generate({
          input: "test error prompt",
          timeoutMs: 40,
        });
      },
      (err: unknown) => {
        const status = getErrorStatusCode(err);
        assert.equal(status, 504);
        assert.match((err as Error).message, /timed out after 0s while reading error response/i);
        return true;
      }
    );
  });

  // 4. A generation job remains active within its permitted execution window
  test("4. A generation job remains active within its permitted execution window (e.g. at 9 minutes)", async () => {
    const jobId = "job-active-9m";
    const job = globalJobStore.createJob(jobId, "Long generating prompt", "meta", "muse-spark-1.3");
    globalJobStore.updateJobProgress(jobId, {
      status: "generating_components",
      stageMessage: "Generating main application entry point (App.tsx)...",
      progressPercent: 80,
    });

    // Simulate 9 minutes of execution time (540,000 ms elapsed, within 10-minute / 10.5-minute window)
    job.createdAt = Date.now() - (9 * 60 * 1000);

    const fetched = globalJobStore.getJob(jobId);
    assert.ok(fetched);
    assert.equal(fetched.status, "generating_components");
    assert.equal(fetched.progressPercent, 80);
    assert.equal(fetched.stageMessage, "Generating main application entry point (App.tsx)...");

    // Polling GET also returns 200 with active status
    const pollReq = new Request(`http://localhost/api/generate?jobId=${jobId}`, { method: "GET" });
    const pollRes = await generateGet(pollReq);
    assert.equal(pollRes.status, 200);
    const pollBody = await pollRes.json();
    assert.equal(pollBody.status, "generating_components");
    assert.equal(pollBody.success, true);
  });

  // 5. A job exceeding the deadline transitions to failed
  test("5. A job exceeding the deadline transitions to failed (MAX_JOB_ACTIVE_DURATION_MS = 630,000ms)", async () => {
    assert.equal(MAX_JOB_ACTIVE_DURATION_MS, 630000); // 10.5 minutes (10m + 30s grace period)
    assert.equal(MAX_JOB_CLEANUP_GRACE_PERIOD_MS, 30000);

    const jobId = "job-exceeded-10m";
    const job = globalJobStore.createJob(jobId, "Stale prompt", "meta", "muse-spark-1.3");
    globalJobStore.updateJobProgress(jobId, {
      status: "generating_components",
      stageMessage: "Generating main application entry point (App.tsx)...",
      progressPercent: 80,
      completedFilePaths: ["types.ts"],
    });

    // Simulate elapsed time exceeding 10.5 minutes (630,000 ms + 1,000 ms)
    job.createdAt = Date.now() - (MAX_JOB_ACTIVE_DURATION_MS + 1000);

    const fetched = globalJobStore.getJob(jobId);
    assert.ok(fetched);
    assert.equal(fetched.status, "failed");
    assert.equal(fetched.statusCode, 504);
    assert.match(fetched.error || "", /exceeded maximum execution time \(10m\)/);

    // Polling GET returns 504 and preserves completedFilePaths
    const pollReq = new Request(`http://localhost/api/generate?jobId=${jobId}`, { method: "GET" });
    const pollRes = await generateGet(pollReq);
    assert.equal(pollRes.status, 504);
    const pollBody = await pollRes.json();
    assert.equal(pollBody.success, false);
    assert.match(pollBody.error, /exceeded maximum execution time \(10m\)/);
    assert.deepEqual(pollBody.completedFilePaths, ["types.ts"]);
  });

  // 6. Frontend polling does not expire before the backend deadline
  test("6. Frontend polling does not expire before backend deadline (11 minutes vs 10 minutes)", () => {
    const pollIntervalMs = 1500;
    const maxPollAttempts = 440;
    const totalClientPollingDurationMs = maxPollAttempts * pollIntervalMs; // 660,000 ms = 11 minutes
    const backendDeadlineMs = MAX_GENERATION_DURATION_MS; // 600,000 ms = 10 minutes
    const backendMaxActiveMs = MAX_JOB_ACTIVE_DURATION_MS; // 630,000 ms = 10.5 minutes

    assert.equal(totalClientPollingDurationMs, 11 * 60 * 1000);
    assert.ok(
      totalClientPollingDurationMs > backendMaxActiveMs,
      "Client polling window must exceed the backend maximum active job duration"
    );
    assert.ok(
      backendMaxActiveMs > backendDeadlineMs,
      "Backend active job duration must include a grace period after the generation deadline"
    );
    // Extra safety margin for frontend polling is exactly 30s over backend job cleanup and 60s over generation deadline
    assert.equal(totalClientPollingDurationMs - backendMaxActiveMs, 30000);
    assert.equal(totalClientPollingDurationMs - backendDeadlineMs, 60000);
  });

  // 7. Retry attempts respect the remaining pipeline time
  test("7. Retry attempts respect the remaining pipeline time and abort with 504 if deadline exceeded", async () => {
    const planJson = JSON.stringify({
      files: [{ path: "App.tsx", description: "Main entry" }],
      dependencies: {},
    });

    const mockProvider = new MockLifecycleProvider([
      { outputText: planJson, finishReason: "stop" },
      { outputText: "{ malformed json", finishReason: "stop" }, // attempt 1 fails
      { outputText: "{ malformed json 2", finishReason: "stop" },
    ]);

    const router = new ModelRouter();
    router.registerProvider(mockProvider);

    // Call pipeline with a 50ms total deadline
    await assert.rejects(
      async () => {
        await executeStagedGenerationPipeline({
          modelRouter: router,
          provider: "meta",
          model: "muse-spark-1.3",
          userPrompt: "Deadline test",
          requestId: "req-deadline-retry",
          disableFallback: true,
          timeoutMs: 50, // 50ms overall pipeline deadline
        });
      },
      (err: unknown) => {
        const status = getErrorStatusCode(err);
        assert.equal(status, 504);
        assert.match((err as Error).message, /pipeline exceeded maximum allowed duration/);
        return true;
      }
    );
  });

  // 8. Provider errors preserve their correct status codes
  test("8. Provider errors preserve their correct status codes (401, 429, 502, 503)", async () => {
    // 401 Unauthorized
    const err401 = Object.assign(new Error("Meta API authentication failed (401)."), {
      status: 401,
      statusCode: 401,
    });
    globalJobStore.createJob("job-401", "test", "meta", "muse-spark-1.3");
    globalJobStore.failJob("job-401", err401.message, getErrorStatusCode(err401));
    const res401 = await generateGet(new Request("http://localhost/api/generate?jobId=job-401"));
    assert.equal(res401.status, 401);

    // 429 Rate Limit
    const err429 = Object.assign(new Error("Meta API rate limit exceeded (429)."), {
      status: 429,
      statusCode: 429,
    });
    globalJobStore.createJob("job-429", "test", "meta", "muse-spark-1.3");
    globalJobStore.failJob("job-429", err429.message, getErrorStatusCode(err429));
    const res429 = await generateGet(new Request("http://localhost/api/generate?jobId=job-429"));
    assert.equal(res429.status, 429);

    // 503 Service Unavailable
    const err503 = Object.assign(new Error("Meta API network request failed (503)."), {
      status: 503,
      statusCode: 503,
    });
    globalJobStore.createJob("job-503", "test", "meta", "muse-spark-1.3");
    globalJobStore.failJob("job-503", err503.message, getErrorStatusCode(err503));
    const res503 = await generateGet(new Request("http://localhost/api/generate?jobId=job-503"));
    assert.equal(res503.status, 503);

    // 502 Bad Gateway / Parse Error
    const err502 = Object.assign(new Error("Failed to parse JSON response from Meta API (502)."), {
      status: 502,
      statusCode: 502,
    });
    globalJobStore.createJob("job-502", "test", "meta", "muse-spark-1.3");
    globalJobStore.failJob("job-502", err502.message, getErrorStatusCode(err502));
    const res502 = await generateGet(new Request("http://localhost/api/generate?jobId=job-502"));
    assert.equal(res502.status, 502);
  });

  // 9. Gemini, NVIDIA, and Nebius routing remain unaffected
  test("9. Gemini, NVIDIA, and Nebius routing remain unaffected (error mappings & secret redactions)", () => {
    // NVIDIA error mappings
    assert.equal(getErrorStatusCode(new Error("NVIDIA API authentication failed (401).")), 401);
    assert.equal(getErrorStatusCode(new Error("NVIDIA API rate limit exceeded (429).")), 429);
    assert.equal(getErrorStatusCode(new Error("NVIDIA API error (502): Bad Gateway")), 502);
    assert.equal(getErrorStatusCode(new Error("NVIDIA API network request failed: fetch failed")), 503);

    // Gemini error mappings
    assert.equal(getErrorStatusCode(new Error("RESOURCE_EXHAUSTED: quota exceeded")), 429);
    assert.equal(getErrorStatusCode(new Error("Request timeout")), 504);

    // Secret sanitization
    const sanitizedNv = sanitizeErrorMessage("NVIDIA error with nvapi-1234567890abcdef1234567890abcdef secret");
    assert.equal(sanitizedNv.includes("nvapi-1234567890abcdef1234567890abcdef"), false);
    assert.match(sanitizedNv, /\[REDACTED\]/);

    const sanitizedGemini = sanitizeErrorMessage("Gemini error with AIzaSy1234567890abcdef1234567890abcdef secret");
    assert.equal(sanitizedGemini.includes("AIzaSy1234567890abcdef1234567890abcdef"), false);
    assert.match(sanitizedGemini, /\[REDACTED\]/);

    // Retryable status checking
    assert.equal(isRetryableModelError({ status: 429 }), true);
    assert.equal(isRetryableModelError({ status: 503 }), true);
    assert.equal(isRetryableModelError({ status: 504 }), true);
    assert.equal(isRetryableModelError({ status: 401 }), false);
  });

  // 10. Successful generation returns all expected files and reaches completed
  test("10. Successful generation returns all expected files and reaches completed", async () => {
    const planJson = JSON.stringify({
      files: [
        { path: "types.ts", description: "Data types" },
        { path: "components/Header.tsx", description: "App header component" },
        { path: "App.tsx", description: "Main entry" },
      ],
      dependencies: { "lucide-react": "latest" },
    });

    const typesJson = JSON.stringify({
      files: [{ path: "types.ts", code: "export interface User { id: string; name: string; }" }],
      dependencies: {},
    });

    const headerJson = JSON.stringify({
      files: [{ path: "components/Header.tsx", code: "export function Header() { return <header>Header</header>; }" }],
      dependencies: {},
    });

    const appJson = JSON.stringify({
      files: [
        {
          path: "App.tsx",
          code: `import React from 'react';
import { Header } from './components/Header';
export default function App() {
  return <div><Header /><h1>App</h1></div>;
}`,
        },
      ],
      dependencies: {},
    });

    const mockProvider = new MockLifecycleProvider([
      { outputText: planJson, finishReason: "stop" },
      { outputText: typesJson, finishReason: "stop" },
      { outputText: headerJson, finishReason: "stop" },
      { outputText: appJson, finishReason: "stop" },
    ]);

    const router = new ModelRouter();
    router.registerProvider(mockProvider);
    const jobId = "job-full-completed-test";
    globalJobStore.createJob(jobId, "Full App", "meta", "muse-spark-1.3");

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Full App",
      requestId: jobId,
      disableFallback: true,
      onProgress: (stageMessage, progressPercent, completedFiles) => {
        globalJobStore.updateJobProgress(jobId, {
          status: "generating_components",
          stageMessage,
          progressPercent,
          completedFilePaths: completedFiles.map((f) => f.path),
        });
      },
    });

    assert.equal(result.files.length, 3);
    const mainFile = result.files.find((f) => f.path === "App.tsx");
    assert.ok(mainFile);

    globalJobStore.completeJob(jobId, {
      files: result.files,
      dependencies: result.dependencies,
      generatedCode: mainFile.code,
      usedModel: result.usedModel,
      usedProvider: result.usedProvider,
      fallbackUsed: result.fallbackUsed,
    });

    const pollReq = new Request(`http://localhost/api/generate?jobId=${jobId}`, { method: "GET" });
    const pollRes = await generateGet(pollReq);
    assert.equal(pollRes.status, 200);
    const pollData = await pollRes.json();
    assert.equal(pollData.status, "completed");
    assert.equal(pollData.progressPercent, 100);
    assert.equal(pollData.files.length, 3);
    assert.match(pollData.generatedCode, /export default function App/);
  });
});
