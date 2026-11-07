import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  executeStagedGenerationPipeline,
  analyzePromptComplexity,
  mergeGeneratedFiles,
  type GeneratedFile,
  type PlannedFile,
} from "./jsonRecovery";
import {
  ModelRouter,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "./modelRouter";
import { ConcurrencyLimiter } from "./rateLimiter";
import { globalJobStore } from "./generationJobs";
import { GET as generateGet, POST as generatePost } from "../app/api/generate/route";

class ScriptedMockProvider implements ModelProvider {
  name = "meta" as const;
  public calls: ModelRequest[] = [];
  public responses: (ModelResponse | Error)[] = [];

  constructor(responses: (ModelResponse | Error)[] = []) {
    this.responses = responses;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const resp = this.responses.shift();
    if (!resp) {
      throw new Error(`ScriptedMockProvider: No response configured for call ${this.calls.length}.`);
    }
    if (resp instanceof Error) {
      throw resp;
    }
    return resp;
  }
}

describe("Phase 2: Large-Application Reliability (30-50 Files)", () => {
  beforeEach(() => {
    globalJobStore.clear();
  });

  // 1. Hierarchical project planning for 30–50 files
  test("1. Hierarchical project planning supports 30-50 planned files across modules without truncation", async () => {
    const enterprisePrompt = `Build an enterprise-grade ERP and supply chain management suite with 35 files:
- Multi-module architecture: Core/Shared, Inventory, Procurement, Orders, Logistics, Analytics, Settings
- Full master-detail views, modal drawers, and telemetry charts`;

    const analysis = analyzePromptComplexity(enterprisePrompt);
    assert.equal(analysis.complexity, "complex");
    assert.equal(analysis.isLargeApp, true);
    assert.equal(analysis.useHierarchicalPlanning, true);
    assert.equal(analysis.maxManifestFiles, 50);

    // Create 35 planned files across 5 modules
    const plannedModules: Array<{ name: string; description: string; files: PlannedFile[] }> = [
      {
        name: "core",
        description: "Core types and utilities",
        files: [
          { path: "types.ts", purpose: "Data interfaces", complexity: "low" as const },
          { path: "lib/utils.ts", purpose: "Formatting helpers", complexity: "low" as const },
        ],
      },
      {
        name: "inventory",
        description: "Warehouse stock management",
        files: Array.from({ length: 8 }, (_, i) => ({
          path: `components/inventory/StockView${i + 1}.tsx`,
          purpose: `Inventory view ${i + 1}`,
          complexity: "medium" as const,
        })),
      },
      {
        name: "orders",
        description: "Order management and fulfillment",
        files: Array.from({ length: 8 }, (_, i) => ({
          path: `components/orders/OrderTable${i + 1}.tsx`,
          purpose: `Order table ${i + 1}`,
          complexity: "medium" as const,
        })),
      },
      {
        name: "logistics",
        description: "Shipment tracking and dispatch",
        files: Array.from({ length: 8 }, (_, i) => ({
          path: `components/logistics/DispatchView${i + 1}.tsx`,
          purpose: `Logistics view ${i + 1}`,
          complexity: "medium" as const,
        })),
      },
      {
        name: "analytics",
        description: "Supply chain analytics and KPIs",
        files: Array.from({ length: 8 }, (_, i) => ({
          path: `components/analytics/KpiChart${i + 1}.tsx`,
          purpose: `Analytics chart ${i + 1}`,
          complexity: "medium" as const,
        })),
      },
    ];

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        plan: "Enterprise ERP and supply chain platform with 35 modular files",
        modules: plannedModules,
        files: [
          ...plannedModules.flatMap((m) => m.files),
          { path: "App.tsx", purpose: "Root application orchestrator", complexity: "high" },
        ],
        dependencies: { "lucide-react": "latest" },
      }),
      finishReason: "stop",
    };

    // Shared files: types.ts, lib/utils.ts (2 calls)
    const typesResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "types.ts", code: "export interface Item { id: string; name: string; }" }],
      }),
    };
    const utilsResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "lib/utils.ts", code: "export function formatCurrency(n: number) { return '$' + n; }" }],
      }),
    };

    // Component files (32 files)
    const componentResponses: ModelResponse[] = Array.from({ length: 32 }, (_, i) => ({
      outputText: JSON.stringify({
        files: [{ path: `components/file_${i}.tsx`, code: `export function Comp${i}() { return <div>Comp ${i}</div>; }` }],
      }),
    }));

    // App.tsx
    const appResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "App.tsx", code: "import React from 'react'; export default function App() { return <div>ERP</div>; }" }],
      }),
    };

    // We configure the mock provider for planning call
    const provider = new ScriptedMockProvider([planResponse, typesResp, utilsResp]);

    let capturedManifest: PlannedFile[] | undefined;
    const router = new ModelRouter();
    router.registerProvider(provider);

    // Initial files passed to simulate existing components
    const existingCompFiles: GeneratedFile[] = Array.from({ length: 32 }, (_, i) => ({
      path: `components/file_${i}.tsx`,
      code: `export function Comp${i}() { return <div>Comp ${i}</div>; }`,
    }));
    existingCompFiles.push({ path: "App.tsx", code: "export default function App() { return <div>ERP</div>; }" });

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: enterprisePrompt,
      requestId: "test-hierarchical-plan-35",
      disableFallback: true,
      initialFiles: existingCompFiles,
      onProgress: (_msg, _pct, _files, _st, _p, _f, manifest) => {
        if (manifest && manifest.length > 0) {
          capturedManifest = manifest;
        }
      },
    });

    // Verify manifest contains 35 planned files (2 shared + 32 components + 1 App.tsx)
    assert.ok(result.manifest);
    assert.equal(result.manifest.length, 35);
    assert.ok(result.manifest.some((f) => f.path === "types.ts"));
    assert.ok(result.manifest.some((f) => f.path === "lib/utils.ts"));
    assert.ok(result.manifest.some((f) => f.path === "App.tsx"));
    assert.ok(result.manifest.some((f) => f.path.startsWith("components/inventory/")));
    assert.ok(result.manifest.some((f) => f.path.startsWith("components/analytics/")));
  });

  // 2. Persistent partial results
  test("2. Partial results are saved for every completed file and preserved even on error", async () => {
    const router = new ModelRouter();

    const planResp: ModelResponse = {
      outputText: JSON.stringify({
        plan: "3-file app with failure on App.tsx",
        files: [
          { path: "types.ts", purpose: "Data types" },
          { path: "components/Chart.tsx", purpose: "Data chart" },
          { path: "App.tsx", purpose: "Root application" },
        ],
      }),
    };

    const typesResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "types.ts", code: "export interface Metric { value: number; }" }],
      }),
    };

    const chartResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "components/Chart.tsx", code: "export function Chart() { return <svg></svg>; }" }],
      }),
    };

    // App.tsx fails with unrecoverable error
    const appFail = new Error("Provider fatal error during App.tsx generation");
    (appFail as unknown as { status: number }).status = 500;

    const provider = new ScriptedMockProvider([planResp, typesResp, chartResp, appFail]);
    router.registerProvider(provider);

    const progressFilesHistory: GeneratedFile[][] = [];

    await assert.rejects(
      async () => {
        await executeStagedGenerationPipeline({
          modelRouter: router,
          provider: "meta",
          model: "muse-spark-1.3",
          userPrompt: "Build an analytics dashboard",
          requestId: "test-partial-persistence",
          disableFallback: true,
          maxComponentRetries: 0,
          onProgress: (_msg, _pct, completedFiles) => {
            progressFilesHistory.push([...completedFiles]);
          },
        });
      },
      (err: Error) => {
        assert.ok(err.message.includes("App.tsx") || err.message.includes("Provider fatal error"));
        return true;
      }
    );

    // Verify that types.ts and components/Chart.tsx were emitted and preserved in progress updates
    const lastProgressFiles = progressFilesHistory[progressFilesHistory.length - 1];
    assert.ok(lastProgressFiles);
    assert.equal(lastProgressFiles.length, 2);
    assert.ok(lastProgressFiles.some((f) => f.path === "types.ts"));
    assert.ok(lastProgressFiles.some((f) => f.path === "components/Chart.tsx"));
    assert.ok(lastProgressFiles.find((f) => f.path === "types.ts")?.code.includes("Metric"));
  });

  // 3. Resumable jobs: skips completed files and only generates pending files
  test("3. Resumable job with resumeJobId skips completed files and only generates pending files", async () => {
    // Seed initial job in globalJobStore
    const initialJob = globalJobStore.createJob(
      "job-to-resume",
      "Build a project management app",
      "meta",
      "muse-spark-1.3",
      [
        { path: "types.ts", code: "export interface Task { id: string; title: string; }" },
        { path: "components/TaskList.tsx", code: "export function TaskList() { return <ul></ul>; }" },
      ],
      [
        { path: "types.ts", purpose: "Task types" },
        { path: "components/TaskList.tsx", purpose: "Task list component" },
        { path: "components/TaskForm.tsx", purpose: "Task creation form" },
        { path: "App.tsx", purpose: "Main app" },
      ]
    );

    // Fail the initial job to simulate an interrupted/timed-out generation
    globalJobStore.failJob("job-to-resume", "Generation interrupted", 504);

    // Call GET /api/generate?jobId=job-to-resume to verify partial files are returned
    const getReq = new Request("http://localhost:3000/api/generate?jobId=job-to-resume");
    const getRes = await generateGet(getReq);
    assert.equal(getRes.status, 504);
    const getBody = await getRes.json();
    assert.equal(getBody.success, false);
    assert.equal(getBody.files.length, 2);
    assert.ok(getBody.completedFilePaths.includes("types.ts"));
    assert.ok(getBody.completedFilePaths.includes("components/TaskList.tsx"));

    // Now resume the job via POST /api/generate
    const router = new ModelRouter();

    // The resumed job should ONLY call model for:
    // 1. components/TaskForm.tsx
    // 2. App.tsx
    // It should NOT call for plan, types.ts, or TaskList.tsx!
    const taskFormResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "components/TaskForm.tsx", code: "export function TaskForm() { return <form></form>; }" }],
      }),
    };
    const appResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "App.tsx", code: "export default function App() { return <div>App</div>; }" }],
      }),
    };

    const provider = new ScriptedMockProvider([taskFormResp, appResp]);
    router.registerProvider(provider);

    const postReq = new Request("http://localhost:3000/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resumeJobId: "job-to-resume",
        mode: "async",
        requestId: "job-resumed-success",
      }),
    });

    const postRes = await generatePost(postReq, { modelRouter: router });
    assert.equal(postRes.status, 200);
    const postBody = await postRes.json();
    assert.equal(postBody.success, true);
    assert.equal(postBody.status, "pending");

    // Wait a brief tick for async background job execution
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify job in store reached completed status
    const resumedJob = globalJobStore.getJob("job-resumed-success");
    assert.ok(resumedJob);
    assert.equal(resumedJob.status, "completed");
    assert.equal(resumedJob.completedFilePaths.length, 4);
    assert.ok(resumedJob.completedFilePaths.includes("types.ts"));
    assert.ok(resumedJob.completedFilePaths.includes("components/TaskList.tsx"));
    assert.ok(resumedJob.completedFilePaths.includes("components/TaskForm.tsx"));
    assert.ok(resumedJob.completedFilePaths.includes("App.tsx"));

    // Confirm model was only called twice (only for ungenerated files: TaskForm and App)
    assert.equal(provider.calls.length, 2);
  });

  // 4. Bounded concurrency execution
  test("4. Controlled execution respects bounded concurrency with ConcurrencyLimiter", async () => {
    const limiter = new ConcurrencyLimiter(3);
    let peakConcurrency = 0;
    let currentInFlight = 0;

    class ConcurrencyTrackingProvider implements ModelProvider {
      name = "meta" as const;
      async generate(_req: ModelRequest): Promise<ModelResponse> {
        currentInFlight++;
        if (currentInFlight > peakConcurrency) {
          peakConcurrency = currentInFlight;
        }
        await new Promise((r) => setTimeout(r, 20));
        currentInFlight--;
        const isApp = _req.input.includes("App.tsx");
        const match = _req.input.match(/"(components\/Comp\d\.tsx)"/);
        const filePath = isApp ? "App.tsx" : (match ? match[1] : "components/Comp.tsx");
        return {
          outputText: JSON.stringify({
            files: [{ path: filePath, code: isApp ? "export default function App() { return null; }" : `export function ${filePath.replace(/[^a-zA-Z0-9]/g, "")}() { return null; }` }],
          }),
        };
      }
    }

    const router = new ModelRouter();
    router.registerProvider(new ConcurrencyTrackingProvider());

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build a multi-component app",
      requestId: "test-concurrency-bounded",
      disableFallback: true,
      concurrencyLimiter: limiter,
      concurrency: 2,
      initialManifest: [
        { path: "components/Comp1.tsx", purpose: "Comp 1" },
        { path: "components/Comp2.tsx", purpose: "Comp 2" },
        { path: "components/Comp3.tsx", purpose: "Comp 3" },
        { path: "components/Comp4.tsx", purpose: "Comp 4" },
        { path: "App.tsx", purpose: "App" },
      ],
    });

    assert.ok(result.files.length >= 4);
    // Bounded concurrency was capped at 2, so peak in-flight calls must be <= 2
    assert.ok(peakConcurrency <= 2, `Peak concurrency was ${peakConcurrency}, expected <= 2`);
    assert.equal(limiter.active, 0, "All concurrency permits must be released in finally blocks");
  });

  // 5. HTTP 429 rate limit backoff adaptively throttles concurrency to 1
  test("5. HTTP 429 rate limit adapts concurrency to sequential (1) and completes successfully", async () => {
    let callCount = 0;
    let hit429 = false;

    class RateLimitThenSuccessProvider implements ModelProvider {
      name = "meta" as const;
      async generate(req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        const promptText = req.input;

        if (promptText.includes("Comp1.tsx") && !hit429) {
          hit429 = true;
          const rateErr = new Error("Upstream Meta 429 rate limit exceeded");
          (rateErr as unknown as { status: number; retryAfter: number }).status = 429;
          (rateErr as unknown as { status: number; retryAfter: number }).retryAfter = 0.05; // 50ms test retry
          throw rateErr;
        }

        const isApp = promptText.includes("App.tsx");
        const path = isApp ? "App.tsx" : "components/Comp1.tsx";
        return {
          outputText: JSON.stringify({
            files: [{ path, code: `export ${isApp ? "default function App()" : "function Comp1()"} { return <div>Ok</div>; }` }],
          }),
        };
      }
    }

    const router = new ModelRouter();
    router.registerProvider(new RateLimitThenSuccessProvider());

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build app with rate limit recovery",
      requestId: "test-429-backoff",
      disableFallback: true,
      concurrency: 2,
      maxComponentRetries: 1,
      initialManifest: [
        { path: "components/Comp1.tsx", purpose: "Comp 1" },
        { path: "App.tsx", purpose: "App" },
      ],
    });

    assert.equal(hit429, true, "Should have encountered simulated 429");
    assert.equal(result.files.length, 2);
    assert.ok(result.files.some((f) => f.path === "components/Comp1.tsx"));
    assert.ok(result.files.some((f) => f.path === "App.tsx"));
  });

  // 6. Retrying only failed files
  test("6. Pipeline retries only the failed/truncated file, preserving completed files", async () => {
    const router = new ModelRouter();

    // Call 1: Comp1 succeeds
    const comp1Success: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "components/Comp1.tsx", code: "export function Comp1() { return <div>1</div>; }" }],
      }),
    };

    // Call 2: Comp2 fails on first attempt with truncated JSON
    const comp2Truncated: ModelResponse = {
      outputText: '{"files":[{"path":"components/Comp2.tsx","code":"export function Comp2() { ret',
      finishReason: "length",
    };

    // Call 3: Comp2 retry succeeds
    const comp2Retry: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "components/Comp2.tsx", code: "export function Comp2() { return <div>2</div>; }" }],
      }),
    };

    // Call 4: App.tsx succeeds
    const appSuccess: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "App.tsx", code: "export default function App() { return <div>All</div>; }" }],
      }),
    };

    const provider = new ScriptedMockProvider([comp1Success, comp2Truncated, comp2Retry, appSuccess]);
    router.registerProvider(provider);

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build resilient components",
      requestId: "test-retry-only-failed",
      disableFallback: true,
      concurrency: 1,
      maxComponentRetries: 1,
      initialManifest: [
        { path: "components/Comp1.tsx", purpose: "Comp 1" },
        { path: "components/Comp2.tsx", purpose: "Comp 2" },
        { path: "App.tsx", purpose: "App" },
      ],
    });

    assert.equal(result.files.length, 3);
    // Comp1 was only generated once (not re-generated during Comp2 retry)
    assert.equal(provider.calls.length, 4);
    assert.ok(provider.calls[0].input.includes("Comp1.tsx"));
    assert.ok(provider.calls[1].input.includes("Comp2.tsx"));
    assert.ok(provider.calls[2].input.includes("Comp2.tsx"));
    assert.ok(provider.calls[3].input.includes("App.tsx"));
  });

  // 7. Duplicate prevention & overwrite protection
  test("7. mergeGeneratedFiles normalizes paths and prevents duplicate entries or accidental overwrites", () => {
    const baseFiles: GeneratedFile[] = [
      { path: "./App.tsx", code: "export default function App() { return <h1>Original</h1>; }" },
      { path: "components\\Sidebar.tsx", code: "export function Sidebar() { return null; }" },
    ];

    const newFiles: GeneratedFile[] = [
      { path: "App.tsx", code: "export default function App() { return <h1>Updated</h1>; }" },
      { path: "components/Sidebar.tsx", code: "export function Sidebar() { return <aside></aside>; }" },
      { path: "components/NewView.tsx", code: "export function NewView() { return null; }" },
    ];

    const merged = mergeGeneratedFiles(baseFiles, newFiles);
    // Paths should be normalized to standard forward slashes without leading './'
    assert.equal(merged.length, 3);
    const paths = merged.map((f) => f.path);
    assert.deepEqual(paths.sort(), ["App.tsx", "components/NewView.tsx", "components/Sidebar.tsx"].sort());

    // Most recent code is preserved for matching normalized paths
    const app = merged.find((f) => f.path === "App.tsx");
    assert.ok(app?.code.includes("Updated"));
  });

  // 8. Deadline management & safe pause
  test("8. Safely pauses before deadline expiration with 504 and preserves partial files for resumption", async () => {
    const router = new ModelRouter();

    // Provider that takes 30ms per file
    class SlowProvider implements ModelProvider {
      name = "meta" as const;
      async generate(req: ModelRequest): Promise<ModelResponse> {
        await new Promise((r) => setTimeout(r, 20));
        const path = req.input.includes("Comp1") ? "components/Comp1.tsx" : "components/Comp2.tsx";
        return {
          outputText: JSON.stringify({
            files: [{ path, code: `export function ${path.replace(/[^a-zA-Z]/g, "")}() { return null; }` }],
          }),
        };
      }
    }

    router.registerProvider(new SlowProvider());

    // Set timeoutMs = 25ms so that Comp1 completes but Comp2 triggers deadline pause (< 15s remaining)
    let preservedFiles: GeneratedFile[] = [];

    await assert.rejects(
      async () => {
        await executeStagedGenerationPipeline({
          modelRouter: router,
          provider: "meta",
          model: "muse-spark-1.3",
          userPrompt: "Build slow application",
          requestId: "test-deadline-pause",
          disableFallback: true,
          timeoutMs: 25,
          concurrency: 1,
          initialManifest: [
            { path: "components/Comp1.tsx", purpose: "Comp 1" },
            { path: "components/Comp2.tsx", purpose: "Comp 2" },
            { path: "App.tsx", purpose: "App" },
          ],
          onProgress: (_msg, _pct, completed) => {
            preservedFiles = [...completed];
          },
        });
      },
      (err: Error) => {
        assert.equal((err as unknown as { status: number }).status, 504);
        assert.ok(err.message.includes("pipeline reached execution limit") || err.message.includes("exceeded maximum allowed duration"));
        return true;
      }
    );

    // Verify partial files were preserved
    assert.ok(preservedFiles.length >= 1);
    assert.ok(preservedFiles.some((f) => f.path === "components/Comp1.tsx"));
  });
});
