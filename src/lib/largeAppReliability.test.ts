import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  executeStagedGenerationPipeline,
  analyzePromptComplexity,
  detectResponseTruncation,
  mergeGeneratedFiles,
  findMissingLocalImports,
  findFirstSyntaxError,
  type GeneratedFile,
} from "./jsonRecovery";
import {
  ModelRouter,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "./modelRouter";
import { globalJobStore } from "./generationJobs";
import { GET as generateGet } from "../app/api/generate/route";

class ScriptedMockProvider implements ModelProvider {
  name = "meta" as const;
  public calls: ModelRequest[] = [];
  public responses: ModelResponse[] = [];

  constructor(responses: ModelResponse[] = []) {
    this.responses = responses;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const resp = this.responses.shift();
    if (!resp) {
      throw new Error(`ScriptedMockProvider: No response configured for call ${this.calls.length}.`);
    }
    return resp;
  }
}

describe("Large-Application Generation Reliability & Multi-Stage Resilience", () => {
  beforeEach(() => {
    globalJobStore.clear();
  });

  // 1. Analyze user prompt complexity
  test("1. analyzePromptComplexity differentiates simple vs large multi-screen applications", () => {
    const simplePrompt = "Build a simple tip calculator";
    const simpleAnalysis = analyzePromptComplexity(simplePrompt);
    assert.equal(simpleAnalysis.complexity, "simple");
    assert.equal(simpleAnalysis.isLargeApp, false);
    assert.equal(simpleAnalysis.maxManifestFiles, 5);

    const largePrompt = `Build a comprehensive enterprise CRM and analytics dashboard SaaS application with:
- Multi-view navigation: Dashboard, Contacts, Deals Pipeline, Activity Calendar, Analytics Charts, and Settings
- Role-based authentication and team permissions
- Deals kanban board with drag-and-drop stages (Lead, Qualified, Proposal, Negotiation, Closed Won)
- Contacts table with sorting, search filters, and CSV export
- Real-time simulated revenue telemetry and conversion rate charts
- Activity timeline with filterable event logs and notifications drawer`;

    const largeAnalysis = analyzePromptComplexity(largePrompt);
    assert.equal(largeAnalysis.complexity, "complex");
    assert.equal(largeAnalysis.isLargeApp, true);
    assert.ok(largeAnalysis.maxManifestFiles >= 10);
    assert.equal(largeAnalysis.suggestedBatchSize, 1);
  });

  // 2. Complete project manifest for large application (> 5 files)
  test("2. Generates complete project manifest for large application (> 5 files) without premature truncation", async () => {
    const router = new ModelRouter();

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        plan: "Enterprise CRM and analytics dashboard with 7 files",
        files: [
          { path: "types.ts", purpose: "CRM and analytics interfaces", complexity: "low" },
          { path: "components/Sidebar.tsx", purpose: "Navigation menu", complexity: "low" },
          { path: "components/Header.tsx", purpose: "User profile and search", complexity: "low" },
          { path: "components/StatsGrid.tsx", purpose: "KPI summary cards", complexity: "medium" },
          { path: "components/DealsKanban.tsx", purpose: "Pipeline kanban board", complexity: "high" },
          { path: "components/ContactsTable.tsx", purpose: "Sortable contacts table", complexity: "high" },
          { path: "App.tsx", purpose: "Root application orchestrator", complexity: "high" },
        ],
        dependencies: { "lucide-react": "latest" },
      }),
      finishReason: "stop",
    };

    const typesResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "types.ts", code: "export interface Contact { id: string; name: string; email: string; }" }],
      }),
    };
    const sidebarResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "components/Sidebar.tsx", code: "import React from 'react'; export function Sidebar() { return <aside>Menu</aside>; }" }],
      }),
    };
    const headerResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "components/Header.tsx", code: "import React from 'react'; export function Header() { return <header>Header</header>; }" }],
      }),
    };
    const statsResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "components/StatsGrid.tsx", code: "import React from 'react'; export function StatsGrid() { return <div>Stats</div>; }" }],
      }),
    };
    const kanbanResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "components/DealsKanban.tsx", code: "import React from 'react'; export function DealsKanban() { return <div>Kanban</div>; }" }],
      }),
    };
    const tableResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "components/ContactsTable.tsx", code: "import React from 'react'; export function ContactsTable() { return <table><tbody><tr><td>Contact</td></tr></tbody></table>; }" }],
      }),
    };
    const appResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          {
            path: "App.tsx",
            code: `import React from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { StatsGrid } from './components/StatsGrid';
import { DealsKanban } from './components/DealsKanban';
import { ContactsTable } from './components/ContactsTable';
export default function App() {
  return (
    <div className="crm-layout">
      <Sidebar />
      <main>
        <Header />
        <StatsGrid />
        <DealsKanban />
        <ContactsTable />
      </main>
    </div>
  );
}`,
          },
        ],
      }),
    };

    const provider = new ScriptedMockProvider([
      planResponse,
      typesResp,
      sidebarResp,
      headerResp,
      statsResp,
      kanbanResp,
      tableResp,
      appResp,
    ]);
    router.registerProvider(provider);

    const progressLogs: string[] = [];
    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build a full enterprise CRM dashboard with analytics, deals kanban, contacts table, sidebar and header",
      requestId: "large-crm-test",
      onProgress: (stage) => progressLogs.push(stage),
    });

    // 7 files generated completely
    assert.equal(result.files.length, 7);
    assert.equal(provider.calls.length, 8); // 1 plan + 7 per-file calls
    assert.equal(findFirstSyntaxError(result.files), null);
    assert.equal(findMissingLocalImports(result.files).length, 0);

    // Verify manifest tracking
    assert.ok(result.manifest);
    assert.equal(result.manifest.length, 7);
  });

  // 3. Per-file generation allocates entire response budget to large files
  test("3. Per-file generation calls model individually for each planned component", async () => {
    const router = new ModelRouter();

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          { path: "components/Chart.tsx", purpose: "Chart view", complexity: "high" },
          { path: "App.tsx", purpose: "Main App", complexity: "high" },
        ],
      }),
    };

    const chartResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "components/Chart.tsx", code: "export function Chart() { return <svg><circle cx='10' cy='10' r='5'/></svg>; }" }],
      }),
    };

    const appResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "App.tsx", code: "import React from 'react'; import { Chart } from './components/Chart'; export default function App() { return <Chart/>; }" }],
      }),
    };

    const provider = new ScriptedMockProvider([planResponse, chartResp, appResp]);
    router.registerProvider(provider);

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build chart application",
      requestId: "per-file-test",
    });

    assert.equal(result.files.length, 2);
    // Verifies provider received distinct per-file prompts for Chart.tsx and App.tsx
    assert.ok(provider.calls[1].input.includes('Generate the component "components/Chart.tsx"'));
    assert.ok(provider.calls[2].input.includes('Generate the main application file "App.tsx"'));
  });

  // 4. Truncation detection and continuation of only incomplete files
  test("4. Detects truncation and continues ONLY incomplete files without restarting completed files", async () => {
    const router = new ModelRouter();

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          { path: "types.ts", purpose: "Types" },
          { path: "components/Editor.tsx", purpose: "Code editor" },
          { path: "App.tsx", purpose: "Root App" },
        ],
      }),
    };

    const typesResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "types.ts", code: "export interface Doc { id: string; content: string; }" }],
      }),
    };

    // Editor.tsx turn 1 reaches output token limit (truncated)
    const truncatedEditorResp: ModelResponse = {
      outputText: '{"files":[{"path":"components/Editor.tsx","code":"import React from \'react\'; export function Editor() { return <textarea val',
      finishReason: "length",
      truncated: true,
    };

    // Editor.tsx turn 2 (targeted continuation) succeeds
    const recoveredEditorResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          {
            path: "components/Editor.tsx",
            code: "import React from 'react'; export function Editor() { return <textarea defaultValue=''></textarea>; }",
          },
        ],
      }),
      finishReason: "stop",
    };

    const appResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          {
            path: "App.tsx",
            code: "import React from 'react'; import { Editor } from './components/Editor'; export default function App() { return <Editor/>; }",
          },
        ],
      }),
    };

    const provider = new ScriptedMockProvider([
      planResponse,
      typesResp,
      truncatedEditorResp,
      recoveredEditorResp,
      appResp,
    ]);
    router.registerProvider(provider);

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build document editor",
      requestId: "trunc-continuation-test",
    });

    assert.equal(result.files.length, 3);
    const typesFile = result.files.find((f) => f.path === "types.ts");
    assert.ok(typesFile);
    assert.equal(typesFile.code, "export interface Doc { id: string; content: string; }");

    // Continuation prompt targeted Editor.tsx specifically
    assert.ok(provider.calls[3].input.includes('The previous attempt for "components/Editor.tsx" was truncated or invalid.'));
  });

  // 5. Adaptive batch sizing drops to per-file generation when batch truncates
  test("5. Adaptive batch sizing recovers completed file and regenerates incomplete file per-file", async () => {
    const router = new ModelRouter();

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          { path: "components/Badge.tsx", purpose: "Status badge" },
          { path: "components/Card.tsx", purpose: "Item card" },
          { path: "App.tsx", purpose: "Root App" },
        ],
      }),
    };

    // Batch containing Badge.tsx and Card.tsx truncates midway after Badge.tsx completes
    const truncatedBatchResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          { path: "components/Badge.tsx", code: "export function Badge({ label }: { label: string }) { return <span>{label}</span>; }" },
        ],
      }).slice(0, -1) + ',{"path":"components/Card.tsx","code":"export function Card() { return <di', // truncated before Card.tsx finishes
      finishReason: "length",
      truncated: true,
    };

    // Targeted per-file recovery for Card.tsx
    const singleCardResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          { path: "components/Card.tsx", code: "import React from 'react'; import { Badge } from './Badge'; export function Card() { return <div><Badge label='New'/>Card</div>; }" },
        ],
      }),
      finishReason: "stop",
    };

    const appResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          { path: "App.tsx", code: "import React from 'react'; import { Card } from './components/Card'; export default function App() { return <Card/>; }" },
        ],
      }),
    };

    const provider = new ScriptedMockProvider([
      planResponse,
      truncatedBatchResp,
      singleCardResp,
      appResp,
    ]);
    router.registerProvider(provider);

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build card app with badge",
      requestId: "adaptive-batch-test",
      batchSize: 2,
    });

    assert.equal(result.files.length, 3);
    assert.ok(result.files.find((f) => f.path === "components/Badge.tsx"));
    assert.ok(result.files.find((f) => f.path === "components/Card.tsx"));
    assert.ok(result.files.find((f) => f.path === "App.tsx"));
    assert.equal(findFirstSyntaxError(result.files), null);
  });

  // 6. Duplicate prevention during recovery and merge
  test("6. Duplicate prevention preserves single normalized version of each file", () => {
    const existing: GeneratedFile[] = [
      { path: "components/Header.tsx", code: "// old version" },
      { path: "types.ts", code: "export interface User { id: string; }" },
    ];

    const recovered: GeneratedFile[] = [
      { path: "./components/Header.tsx", code: "// new complete version" },
      { path: "components/Footer.tsx", code: "// new footer" },
    ];

    const merged = mergeGeneratedFiles(existing, recovered);
    assert.equal(merged.length, 3);
    const header = merged.find((f) => f.path === "components/Header.tsx");
    assert.ok(header);
    assert.equal(header.code, "// new complete version");

    // Duplicate path with backslashes
    const windowsPath: GeneratedFile[] = [
      { path: "components\\Footer.tsx", code: "// windows path update" },
    ];
    const remerged = mergeGeneratedFiles(merged, windowsPath);
    assert.equal(remerged.length, 3);
    const footer = remerged.find((f) => f.path === "components/Footer.tsx");
    assert.equal(footer?.code, "// windows path update");
  });

  // 7. Tracking generated, pending, and failed files in job progress
  test("7. Tracks generated, pending, and failed files in globalJobStore and polling endpoint", async () => {
    const jobId = "job-track-manifest-test";
    const job = globalJobStore.createJob(jobId, "CRM app", "meta", "muse-spark-1.3");

    assert.deepEqual(job.completedFilePaths, []);
    assert.deepEqual(job.pendingFilePaths, []);
    assert.deepEqual(job.failedFilePaths, []);

    // Update with pending files
    globalJobStore.updateJobProgress(jobId, {
      status: "generating_components",
      stageMessage: "Generating components...",
      progressPercent: 40,
      completedFilePaths: ["types.ts"],
      pendingFilePaths: ["types.ts", "components/Header.tsx", "components/Sidebar.tsx", "App.tsx"],
    });

    const activeJob = globalJobStore.getJob(jobId);
    assert.ok(activeJob);
    assert.deepEqual(activeJob.completedFilePaths, ["types.ts"]);
    // Completed files automatically removed from pendingFilePaths
    assert.deepEqual(activeJob.pendingFilePaths?.sort(), ["App.tsx", "components/Header.tsx", "components/Sidebar.tsx"].sort());

    // Record a failed file
    globalJobStore.updateJobProgress(jobId, {
      failedFilePaths: ["components/Sidebar.tsx"],
    });

    const jobWithFailure = globalJobStore.getJob(jobId);
    assert.deepEqual(jobWithFailure?.failedFilePaths, ["components/Sidebar.tsx"]);
    // Failed files automatically removed from pending
    assert.deepEqual(jobWithFailure?.pendingFilePaths?.sort(), ["App.tsx", "components/Header.tsx"].sort());

    // GET /api/generate?jobId=... includes completed, pending, and failed files
    const req = new Request(`http://localhost/api/generate?jobId=${jobId}`);
    const res = await generateGet(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.completedFilePaths, ["types.ts"]);
    assert.deepEqual(body.pendingFilePaths.sort(), ["App.tsx", "components/Header.tsx"].sort());
    assert.deepEqual(body.failedFilePaths, ["components/Sidebar.tsx"]);
  });

  // 8. Partial auxiliary component failure does not crash entire generation
  test("8. Partial auxiliary component failure records failed file and still completes application", async () => {
    const router = new ModelRouter();

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          { path: "components/BadWidget.tsx", purpose: "Unstable widget" },
          { path: "components/GoodWidget.tsx", purpose: "Stable widget" },
          { path: "App.tsx", purpose: "Root application" },
        ],
      }),
    };

    // BadWidget fails both attempts
    const badFail1: ModelResponse = { outputText: "{ broken json", finishReason: "stop" };
    const badFail2: ModelResponse = { outputText: "{ still broken", finishReason: "stop" };

    const goodResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "components/GoodWidget.tsx", code: "export function GoodWidget() { return <div>Good</div>; }" }],
      }),
    };

    const appResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "App.tsx", code: "import React from 'react'; import { GoodWidget } from './components/GoodWidget'; export default function App() { return <GoodWidget/>; }" }],
      }),
    };

    const provider = new ScriptedMockProvider([
      planResponse,
      badFail1,
      badFail2,
      goodResp,
      appResp,
    ]);
    router.registerProvider(provider);

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build widget dashboard",
      requestId: "partial-fail-test",
      maxComponentRetries: 1,
    });

    assert.equal(result.files.length, 2);
    assert.ok(result.files.find((f) => f.path === "components/GoodWidget.tsx"));
    assert.ok(result.files.find((f) => f.path === "App.tsx"));
    assert.deepEqual(result.failedFiles, ["components/BadWidget.tsx"]);
  });

  // 9. Complete project validation detects and repairs missing local imports
  test("9. Stage 5 validates project and generates missing local relative imports", async () => {
    const router = new ModelRouter();

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "App.tsx", purpose: "Root App" }],
      }),
    };

    // App.tsx imports Modal and Banner that were not in initial plan
    const appResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          {
            path: "App.tsx",
            code: `import React from 'react';
import { Modal } from './components/Modal';
export default function App() {
  return <div><Modal/></div>;
}`,
          },
        ],
      }),
    };

    // Targeted repair creates components/Modal.tsx
    const repairModal: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "components/Modal.tsx", code: "import React from 'react'; export function Modal() { return <dialog open>Modal</dialog>; }" }],
      }),
    };

    const provider = new ScriptedMockProvider([planResponse, appResponse, repairModal]);
    router.registerProvider(provider);

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "App with modal",
      requestId: "missing-import-stage5-test",
    });

    assert.equal(result.files.length, 2);
    assert.ok(result.files.find((f) => f.path === "components/Modal.tsx"));
    assert.equal(findMissingLocalImports(result.files).length, 0);
  });

  // 10. Pipeline deadline enforcement aborts safely with 504
  test("10. Generation deadline is enforced across multi-stage execution and aborts with HTTP 504", async () => {
    const router = new ModelRouter();

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "App.tsx", purpose: "App" }],
      }),
    };

    const slowProvider: ModelProvider = {
      name: "meta",
      generate: async () => {
        await new Promise((r) => setTimeout(r, 40));
        return planResponse;
      },
    };
    router.registerProvider(slowProvider);

    // Call pipeline with 20ms timeout
    await assert.rejects(
      async () => {
        await executeStagedGenerationPipeline({
          modelRouter: router,
          provider: "meta",
          model: "muse-spark-1.3",
          userPrompt: "Timeout app",
          requestId: "deadline-abort-test",
          timeoutMs: 20, // 20ms expires before Stage 4
        });
      },
      (err: unknown) => {
        const error = err as { status?: number; statusCode?: number; message?: string };
        assert.equal(error.status || error.statusCode, 504);
        assert.match(error.message || "", /pipeline exceeded maximum allowed duration/i);
        return true;
      }
    );
  });
});
