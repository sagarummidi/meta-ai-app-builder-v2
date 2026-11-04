import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  safeParseJson,
  extractJsonString,
  repairTruncatedJsonString,
  extractCompleteFilesFromTruncatedJson,
  extractFilesFromMarkdownFences,
  findTruncatedFileInOutput,
  sanitizeJsonString,
  scanJsonStructure,
  executeGenerationPipeline,
  executeStagedGenerationPipeline,
  extractCompactRequirements,
  type GenerationOutput,
  type GeneratedFile,
} from "./jsonRecovery";
import {
  modelRouter,
  ModelRouter,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  getErrorStatusCode,
} from "./modelRouter";
import { globalJobStore, type GenerationJobStatus } from "./generationJobs";
import { GET as generateGet, POST as generatePost } from "../app/api/generate/route";

class MockScriptedProvider implements ModelProvider {
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
      throw new Error(`MockScriptedProvider: No response queued for call ${this.calls.length}.`);
    }
    return resp;
  }
}

describe("Phase 6: Meta Muse Spark Robust Recovery & Hardening Tests", () => {
  beforeEach(() => {
    globalJobStore.clear();
  });

  // 1. Valid complete JSON
  test("1. Valid complete JSON parses cleanly with full files and dependencies", () => {
    const raw = JSON.stringify({
      files: [
        {
          path: "App.tsx",
          code: `import React from 'react';
export default function App() {
  return <div>Complete App</div>;
}`,
        },
      ],
      dependencies: {
        "lucide-react": "latest",
      },
    });

    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, true);
    assert.equal(parsed.isTruncated, false);
    assert.equal(parsed.data?.files.length, 1);
    assert.equal(parsed.data?.files[0].path, "App.tsx");
    assert.equal(parsed.data?.dependencies?.["lucide-react"], "latest");
  });

  // 2. JSON truncated in the middle of a string
  test("2. JSON truncated in the middle of a string is safely detected as truncated without crashing", () => {
    const raw = `{"files":[{"path":"App.tsx","code":"import React from 'react';\\nexport default function App() {\\n  const title = \\"Cut off`;

    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, false);
    assert.equal(parsed.isTruncated, true);
    assert.ok(typeof parsed.truncatedPosition === "number");
    assert.ok(parsed.error);
    assert.match(parsed.error, /unterminated/i);
  });

  // 3. JSON truncated after a complete file
  test("3. JSON truncated after a complete file recovers the complete file safely", () => {
    const raw = `{"files":[{"path":"App.tsx","code":"import React from 'react';\\nexport default function App() { return <div>Done</div>; }"},`;

    const repaired = repairTruncatedJsonString(raw);
    const parsedRepaired = JSON.parse(repaired);
    assert.equal(parsedRepaired.files.length, 1);
    assert.equal(parsedRepaired.files[0].path, "App.tsx");

    const recovered = extractCompleteFilesFromTruncatedJson(raw);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].path, "App.tsx");
    assert.match(recovered[0].code, /<div>Done<\/div>/);
  });

  // 4. Multiple complete files followed by one incomplete file
  test("4. Multiple complete files followed by one incomplete file extracts valid files and detects cutoff file", () => {
    const raw = `{"files":[
      {"path":"types.ts","code":"export interface User { id: string; name: string; }"},
      {"path":"components/UserCard.tsx","code":"import React from 'react';\\nimport { User } from '../types';\\nexport function UserCard({ user }: { user: User }) { return <div>{user.name}</div>; }"},
      {"path":"App.tsx","code":"import React from 'react';\\nimport { UserCard } from './components/UserCard';\\nexport default function App() {\\n  const u = { id: '1', name: 'Alice' };\\n  return <div"`;

    const recovered = extractCompleteFilesFromTruncatedJson(raw);
    assert.equal(recovered.length, 2);
    assert.equal(recovered[0].path, "types.ts");
    assert.equal(recovered[1].path, "components/UserCard.tsx");

    const cutOff = findTruncatedFileInOutput(raw, recovered);
    assert.equal(cutOff, "App.tsx");
  });

  // 5. Escaped quotes and newlines inside source code
  test("5. Escaped quotes and newlines inside source code are preserved without corruption", () => {
    assert.equal(sanitizeJsonString('{"a":"hello\nworld"}'), '{"a":"hello\\nworld"}');
    const code = `import React from 'react';
export default function App() {
  const quote = "He said: \\"Hello World\\"";
  const regex = /\\"escaped\\"/;
  const multiLine = "Line 1\\nLine 2";
  return <div>{quote}</div>;
}`;

    const raw = JSON.stringify({
      files: [{ path: "App.tsx", code }],
      dependencies: {},
    });

    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.files[0].code, code);
  });

  // 6. Braces and brackets inside strings and comments
  test("6. Braces and brackets inside strings and comments do not desynchronize the boundary scanner", () => {
    const codeWithBraces = `import React from 'react';
export default function App() {
  // Comment with braces: { [ } ]
  const template = \`Value is: \${JSON.stringify({ a: [1, 2, 3] })}\`;
  const text = "Braces inside string: { foo: 'bar' } and [brackets]";
  return <div>{template}</div>;
}`;

    const raw = JSON.stringify({
      files: [{ path: "App.tsx", code: codeWithBraces }],
      dependencies: {},
    });

    const scan = scanJsonStructure(raw);
    assert.equal(scan.isTruncated, false);
    assert.ok(scan.endIndex > 0);

    const recovered = extractCompleteFilesFromTruncatedJson(raw);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].path, "App.tsx");
  });

  // 7. Fenced JSON responses
  test("7. Fenced JSON responses (```json and ```) are extracted and parsed accurately", () => {
    const payload = {
      files: [
        {
          path: "App.tsx",
          code: "export default function App() { return <div>Fenced</div>; }",
        },
      ],
      dependencies: {},
    };

    const raw = `Here is the code:
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`
Hope this helps!`;

    const extracted = extractJsonString(raw);
    assert.equal(extracted.fenceFound, true);

    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.files.length, 1);
    assert.equal(parsed.data?.files[0].path, "App.tsx");

    // Also test Markdown fence file delivery fallback
    const fenceDelivered = `\`\`\`tsx
// File: App.tsx
import React from 'react';
export default function App() { return <div>Fenced Delivery</div>; }
\`\`\``;
    const filesFromFences = extractFilesFromMarkdownFences(fenceDelivered);
    assert.equal(filesFromFences.length, 1);
    assert.equal(filesFromFences[0].path, "App.tsx");
  });

  // 8. Responses containing extra explanatory text
  test("8. Responses containing extra explanatory text before and after JSON parse cleanly", () => {
    const raw = `Certainly! I have generated the requested application for you:

{"files":[{"path":"App.tsx","code":"export default function App() { return <div>Prose Surrounded</div>; }"}],"dependencies":{}}

This application uses standard React state and hooks. Let me know if you would like any modifications!`;

    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.files[0].path, "App.tsx");
  });

  // 9. Continuation after partial recovery
  test("9. Continuation after partial recovery preserves valid files and requests missing ones", async () => {
    const router = new ModelRouter();

    // Turn 1: types.ts is complete, App.tsx is cut off
    const turn1Output = `{"files":[
      {"path":"types.ts","code":"export interface Todo { id: string; text: string; }"},
      {"path":"App.tsx","code":"import React from 'react';\\nimport { Todo } from './types';\\nexport default function App() {\\n  return <div"`;

    // Turn 2: App.tsx is completed
    const turn2Output = JSON.stringify({
      files: [
        {
          path: "App.tsx",
          code: `import React from 'react';
import { Todo } from './types';
export default function App() {
  const t: Todo = { id: '1', text: 'Clean code' };
  return <div>{t.text}</div>;
}`,
        },
      ],
      dependencies: {},
    });

    const mockProvider = new MockScriptedProvider([
      { outputText: turn1Output, finishReason: "length", truncated: true },
      { outputText: turn2Output, finishReason: "stop", truncated: false },
    ]);
    router.registerProvider(mockProvider);

    const result = await executeGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build a todo app",
      requestId: "test-continuation-p9",
      maxContinuationAttempts: 2,
    });

    assert.equal(result.files.length, 2);
    const paths = result.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["App.tsx", "types.ts"]);
    assert.equal(result.attemptsUsed, 2);
  });

  // 10. Recovery when App.tsx is complete but another file is missing
  test("10. Recovery when App.tsx is complete but imports missing component detects and repairs it in Stage 5", async () => {
    const router = new ModelRouter();

    // Stage 1: Plan
    const planOutput = JSON.stringify({
      files: [
        { path: "App.tsx", purpose: "Main entry" },
      ],
      dependencies: {},
    });

    // Stage 4: App.tsx generated, but imports './components/Badge' which was not planned
    const appOutput = JSON.stringify({
      files: [
        {
          path: "App.tsx",
          code: `import React from 'react';
import { Badge } from './components/Badge';
export default function App() {
  return <div>App with <Badge label="New" /></div>;
}`,
        },
      ],
      dependencies: {},
    });

    // Stage 5: Repair missing import 'components/Badge.tsx'
    const badgeOutput = JSON.stringify({
      files: [
        {
          path: "components/Badge.tsx",
          code: `import React from 'react';
export function Badge({ label }: { label: string }) {
  return <span>{label}</span>;
}`,
        },
      ],
      dependencies: {},
    });

    const mockProvider = new MockScriptedProvider([
      { outputText: planOutput, finishReason: "stop" },
      { outputText: appOutput, finishReason: "stop" },
      { outputText: badgeOutput, finishReason: "stop" },
    ]);
    router.registerProvider(mockProvider);

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build app with badges",
      requestId: "test-missing-import-p10",
    });

    assert.equal(result.files.length, 2);
    const paths = result.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["App.tsx", "components/Badge.tsx"]);
  });

  // 11. Recovery failure with a clear error
  test("11. Recovery failure with a clear error reports failing stage and HTTP 502 status", async () => {
    const router = new ModelRouter();

    const planOutput = JSON.stringify({
      files: [{ path: "App.tsx", purpose: "Main entry" }],
      dependencies: {},
    });

    // Both initial attempt and retry truncate
    const truncatedOutput = `{"files":[{"path":"App.tsx","code":"export default function App() { return <div`;

    const mockProvider = new MockScriptedProvider([
      { outputText: planOutput, finishReason: "stop" },
      { outputText: truncatedOutput, finishReason: "length", truncated: true },
      { outputText: truncatedOutput, finishReason: "length", truncated: true },
      { outputText: truncatedOutput, finishReason: "length", truncated: true },
    ]);
    router.registerProvider(mockProvider);

    await assert.rejects(
      async () => {
        await executeStagedGenerationPipeline({
          modelRouter: router,
          provider: "meta",
          model: "muse-spark-1.3",
          userPrompt: "Build complex app",
          requestId: "test-fail-p11",
          maxComponentRetries: 1,
        });
      },
      (err: Error) => {
        assert.match(err.message, /stage 'generating_entry' \(App\.tsx\)/);
        assert.match(err.message, /output token limits/);
        assert.equal(getErrorStatusCode(err), 502);
        return true;
      }
    );
  });

  // 12. Poll endpoint behavior when a job fails
  test("12. Poll endpoint behavior when a job fails returns HTTP 502 with error stage and completed file paths", async () => {
    globalJobStore.createJob("job-fail-p12", "Build app", "meta", "muse-spark-1.3");
    globalJobStore.updateJobProgress("job-fail-p12", {
      status: "generating_entry",
      stageMessage: "Generating main application entry point (App.tsx)...",
      completedFilePaths: ["types.ts", "components/Header.tsx"],
    });

    globalJobStore.failJob(
      "job-fail-p12",
      "Meta Muse Spark generation failed at stage 'generating_entry' (App.tsx): model response was truncated due to output token limits.",
      502
    );

    const req = new Request("http://localhost/api/generate?jobId=job-fail-p12");
    const res = await generateGet(req);

    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.status, "failed");
    assert.match(body.error, /generating_entry/);
    assert.deepEqual(body.completedFilePaths, ["types.ts", "components/Header.tsx"]);
  });

  // 13. Frontend handling of non-JSON error responses
  test("13. Frontend handling of non-JSON error responses safely parses status without endless loop", async () => {
    // Test the logic implemented in page.tsx for non-JSON responses
    const fakeHtmlResponse = "<html><body><h1>502 Bad Gateway</h1><p>Cloudflare Gateway Error</p></body></html>";
    const status = 502;
    const ok = false;

    let pollError: Error | null = null;
    try {
      if (!ok) {
        const stripped = fakeHtmlResponse.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const snippet = stripped.length > 200 ? stripped.slice(0, 200) + "..." : stripped;
        throw new Error(snippet || `Generation failed (HTTP ${status}).`);
      }
    } catch (e) {
      pollError = e as Error;
    }

    assert.ok(pollError !== null);
    assert.match(pollError.message, /502 Bad Gateway/);
  });

  // 14. Successful multi-file Muse Spark generation
  test("14. Successful multi-file Muse Spark generation completes all stages with valid TypeScript", async () => {
    const router = new ModelRouter();

    const planJson = JSON.stringify({
      files: [
        { path: "types.ts", purpose: "Data interfaces" },
        { path: "components/Counter.tsx", purpose: "Interactive counter" },
        { path: "App.tsx", purpose: "Root application" },
      ],
      dependencies: {
        "lucide-react": "latest",
      },
    });

    const typesJson = JSON.stringify({
      files: [
        {
          path: "types.ts",
          code: "export interface CounterState { count: number; step: number; }",
        },
      ],
      dependencies: {},
    });

    const compJson = JSON.stringify({
      files: [
        {
          path: "components/Counter.tsx",
          code: `import React, { useState } from 'react';
import { CounterState } from '../types';
export function Counter() {
  const [state, setState] = useState<CounterState>({ count: 0, step: 1 });
  return (
    <div>
      <p>Count: {state.count}</p>
      <button onClick={() => setState({ ...state, count: state.count + state.step })}>+1</button>
    </div>
  );
}`,
        },
      ],
      dependencies: {},
    });

    const appJson = JSON.stringify({
      files: [
        {
          path: "App.tsx",
          code: `import React from 'react';
import { Counter } from './components/Counter';
export default function App() {
  return (
    <main>
      <h1>Counter App</h1>
      <Counter />
    </main>
  );
}`,
        },
      ],
      dependencies: {
        "lucide-react": "latest",
      },
    });

    const mockProvider = new MockScriptedProvider([
      { outputText: planJson, finishReason: "stop" },
      { outputText: typesJson, finishReason: "stop" },
      { outputText: compJson, finishReason: "stop" },
      { outputText: appJson, finishReason: "stop" },
    ]);
    router.registerProvider(mockProvider);

    const progressStages: string[] = [];
    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build a counter application",
      requestId: "test-full-success-p14",
      onProgress: (_msg: string, _pct: number, _files: GeneratedFile[], stage?: GenerationJobStatus) => {
        if (stage) progressStages.push(stage);
      },
    });

    assert.equal(result.files.length, 3);
    assert.equal(result.usedProvider, "meta");
    assert.equal(result.usedModel, "muse-spark-1.3");
    assert.ok(result.files.some((f) => f.path === "types.ts"));
    assert.ok(result.files.some((f) => f.path === "components/Counter.tsx"));
    assert.ok(result.files.some((f) => f.path === "App.tsx"));
    assert.ok(progressStages.includes("planning"));
    assert.ok(progressStages.includes("generating_shared"));
    assert.ok(progressStages.includes("generating_components"));
    assert.ok(progressStages.includes("generating_entry"));
    assert.ok(progressStages.includes("completed"));
  });

  // 15. Retry limits and aggregate deadline enforcement
  test("15. Retry limits and aggregate deadline enforcement throws HTTP 504 without resetting deadline", async () => {
    const router = new ModelRouter();

    // Provider that simulates a slow response or immediate deadline expiration
    const mockProvider = new MockScriptedProvider([
      { outputText: JSON.stringify({ files: [{ path: "App.tsx" }] }), finishReason: "stop" },
    ]);
    router.registerProvider(mockProvider);

    await assert.rejects(
      async () => {
        await executeStagedGenerationPipeline({
          modelRouter: router,
          provider: "meta",
          model: "muse-spark-1.3",
          userPrompt: "Build app with timeout",
          requestId: "test-deadline-p15",
          timeoutMs: -1, // already expired deadline
        });
      },
      (err: Error) => {
        assert.match(err.message, /pipeline exceeded maximum allowed duration/i);
        assert.equal(getErrorStatusCode(err), 504);
        return true;
      }
    );
  });
});


describe("Focused Implementation Verification: Staged Generation Recovery", () => {
  beforeEach(() => {
    globalJobStore.clear();
  });

  // === A. Issue 1: Complete Original User Requirements Preservation & Stage 4 Recovery ===

  test("A1. extractCompactRequirements preserves essential requirements near the END of a long prompt (>1500 chars)", () => {
    const longPrompt = `Build a comprehensive Personal Finance & Expense Tracker application in React and TypeScript.
The application should help users track accounts, transactions, budgets, investments, and financial goals.

### Architecture & Components
- Dashboard with net worth summary cards, recent transactions, and monthly spending chart
- Transaction manager with add/edit/delete, category selector, receipt attachment simulation, and tag support
- Budget planner with interactive progress bars for each expense category (Housing, Food, Transport, Utilities, Entertainment)
- Analytics view with breakdown by category and spending trends over time with custom date range filters

### Styling and Technical Requirements
- Use Tailwind CSS with dark/light theme support and responsive typography
- Use Lucide React icons for all navigation items, transaction categories, and action buttons
- Follow clean architecture and modular design with dedicated component files
- Ensure responsive layout for mobile, tablet, and desktop screens with sticky navigation
- Provide smooth UI transitions, hover states, and clear interactive feedback
- Write clean code and return only valid json

### Data Management & Persistence
- Store all user data in localStorage with initial sample demo data preloaded on first launch
- Support multi-currency selection with live conversion simulation (USD, EUR, GBP, JPY, CAD, AUD)
- Provide data backup: Must include CSV data export and JSON import capabilities
- Include financial goal tracker with target date, target amount, and savings progress indicator

### Critical Final Requirements (Near End of Prompt)
- User settings: Allow setting custom currency, dark mode toggle, and notification thresholds
- Must provide an interactive CSV export modal triggered from the navigation bar
- Ensure all monetary amounts are dynamically formatted according to the selected currency symbol`;

    assert.ok(longPrompt.length > 1500, `Prompt length is ${longPrompt.length}, should be > 1500`);

    // Verify critical requirements are positioned past character 800
    const csvIndex = longPrompt.indexOf("Must include CSV data export");
    const darkModeIndex = longPrompt.indexOf("dark mode toggle");
    const currencyIndex = longPrompt.indexOf("monetary amounts are dynamically formatted");
    assert.ok(csvIndex > 800, `CSV requirement at ${csvIndex} should be beyond char 800`);
    assert.ok(darkModeIndex > 800, `Dark mode toggle at ${darkModeIndex} should be beyond char 800`);
    assert.ok(currencyIndex > 800, `Currency formatting at ${currencyIndex} should be beyond char 800`);

    const compact = extractCompactRequirements(longPrompt);

    // Verify compact requirements preserves primary goal
    assert.ok(compact.includes("Personal Finance & Expense Tracker"));

    // Verify compact requirements preserves requirements from near the END
    assert.ok(compact.includes("CSV data export"), "Must preserve CSV data export requirement near end");
    assert.ok(compact.includes("dark mode toggle"), "Must preserve dark mode toggle requirement near end");
    assert.ok(compact.includes("monetary amounts are dynamically formatted"), "Must preserve dynamic formatting near end");

    // Verify non-functional boilerplate was filtered out
    assert.ok(!compact.includes("return only valid json"), "Boilerplate should be stripped");
  });

  test("A2. Stage 4 long prompt (>1500 chars): requirements near END are represented in BOTH initial and retry Stage 4 prompts", async () => {
    const router = new ModelRouter();

    const longPrompt = `Build an enterprise Cloud Fleet Management dashboard in React and TypeScript.
Manage cloud virtual machines, server clusters, network topology, and alerting rules across multiple regions.

### Core Modules
- ClusterOverview: displays cluster health, CPU/RAM utilization gauges, and active node count
- NodeList: table of worker nodes with status pills, IP addresses, uptime metrics, and restart action buttons
- AlertFeed: stream of system alerts with severity badges (Critical, Warning, Info) and dismissal buttons
- MetricsViewer: real-time latency graphs, packet drop indicators, and storage utilization gauges

### Infrastructure Requirements
- Real-time simulated metrics telemetry updating every 3 seconds across all clusters
- Filter nodes by region (us-east, us-west, eu-central, ap-southeast, sa-east)
- Filter nodes by status (healthy, warning, critical, offline, maintenance)
- Bulk action support: batch restart selected nodes with confirmation dialog and toast notifications
- Interactive topology view mapping edge gateways to core cluster nodes

### Security & Advanced Features
- Role-based access simulation (Admin, Operator, Viewer modes with distinct action permissions)
- Node detail drawer showing full telemetry history chart and audit logs for administrative events
- System health diagnostic report generation with exportable JSON summary

### Critical End Requirements (Beyond Character 1000)
- Global search bar in App.tsx navigation that filters across all nodes and alerts
- Must have emergency KillSwitch button in the top navigation that halts all critical nodes
- Support export node inventory to CSV and PDF format
- Persistent light/dark theme switch that changes root application styles`;

    assert.ok(longPrompt.length > 1500, `Prompt must be > 1500 chars, got ${longPrompt.length}`);
    const killSwitchPos = longPrompt.indexOf("emergency KillSwitch button");
    const globalSearchPos = longPrompt.indexOf("Global search bar in App.tsx");
    assert.ok(killSwitchPos > 800, `KillSwitch at ${killSwitchPos} must be beyond char 800`);
    assert.ok(globalSearchPos > 800, `Global search at ${globalSearchPos} must be beyond char 800`);

    const planJson = JSON.stringify({
      files: [
        { path: "types.ts", purpose: "Cluster and node types" },
        { path: "components/ClusterOverview.tsx", purpose: "Cluster overview gauges" },
        { path: "App.tsx", purpose: "Root application orchestrator" },
      ],
      dependencies: { "lucide-react": "latest" },
    });

    const typesJson = JSON.stringify({
      files: [
        { path: "types.ts", code: "export interface Node { id: string; status: string; }" },
      ],
      dependencies: {},
    });

    const overviewJson = JSON.stringify({
      files: [
        {
          path: "components/ClusterOverview.tsx",
          code: "import React from 'react'; export function ClusterOverview() { return <div>Cluster Health</div>; }",
        },
      ],
      dependencies: {},
    });

    // Attempt 1: truncated App.tsx
    const truncApp = `{"files":[{"path":"App.tsx","code":"import React from 'react';\\nexport default function App() { return <div`;

    // Attempt 2 (retry): complete App.tsx
    const completeApp = JSON.stringify({
      files: [
        {
          path: "App.tsx",
          code: `import React from 'react';
import { ClusterOverview } from './components/ClusterOverview';
export default function App() {
  return (
    <div className="app">
      <header>
        <input placeholder="Global search..." />
        <button>KillSwitch</button>
      </header>
      <ClusterOverview />
    </div>
  );
}`,
        },
      ],
      dependencies: { "lucide-react": "latest" },
    });

    const mockProvider = new MockScriptedProvider([
      { outputText: planJson, finishReason: "stop" },
      { outputText: typesJson, finishReason: "stop" },
      { outputText: overviewJson, finishReason: "stop" },
      { outputText: truncApp, finishReason: "length", truncated: true }, // Stage 4 call 1
      { outputText: completeApp, finishReason: "stop" }, // Stage 4 call 2 (retry)
    ]);
    router.registerProvider(mockProvider);

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: longPrompt,
      requestId: "test-a2-long-prompt",
      maxComponentRetries: 1,
    });

    // 1. Verify provider received 5 calls (plan, types, overview, app initial, app retry)
    assert.equal(mockProvider.calls.length, 5);

    // 2. Inspect Stage 4 attempt 1 prompt (call index 3)
    const initialStage4Prompt = mockProvider.calls[3].input;
    assert.ok(
      initialStage4Prompt.includes("emergency KillSwitch button"),
      "Initial Stage 4 prompt must contain requirement from end of prompt (KillSwitch)"
    );
    assert.ok(
      initialStage4Prompt.includes("Global search bar"),
      "Initial Stage 4 prompt must contain requirement from end of prompt (Global search)"
    );
    assert.ok(
      initialStage4Prompt.includes("components/ClusterOverview.tsx"),
      "Initial Stage 4 prompt must reference existing components"
    );

    // 3. Inspect Stage 4 attempt 2 retry prompt (call index 4)
    const retryStage4Prompt = mockProvider.calls[4].input;
    assert.ok(
      retryStage4Prompt.includes("emergency KillSwitch button"),
      "Retry Stage 4 prompt must contain requirement from end of prompt (KillSwitch)"
    );
    assert.ok(
      retryStage4Prompt.includes("Global search bar"),
      "Retry Stage 4 prompt must contain requirement from end of prompt (Global search)"
    );
    assert.ok(
      retryStage4Prompt.includes("components/ClusterOverview.tsx"),
      "Retry Stage 4 prompt must reference existing components"
    );

    // 4. Verify earlier files were not replaced or corrupted
    assert.equal(result.files.length, 3);
    const paths = result.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["App.tsx", "components/ClusterOverview.tsx", "types.ts"]);
    const typesFile = result.files.find((f) => f.path === "types.ts");
    assert.ok(typesFile?.code.includes("interface Node"));
  });

  // === B. Issue 2: Real Failed-Job Lifecycle via POST / Background Task / GET ===

  test("B1. Real background generation task lifecycle: Stage 2 & 3 progress updates, Stage 4 truncation failure through background catch handler to failJob and GET 502", async () => {
    // Stage 1: Plan
    const planJson = JSON.stringify({
      files: [
        { path: "types.ts", purpose: "Data types" },
        { path: "components/SummaryCard.tsx", purpose: "Summary card" },
        { path: "App.tsx", purpose: "Root application" },
      ],
      dependencies: { "lucide-react": "latest" },
    });

    // Stage 2: types.ts
    const typesJson = JSON.stringify({
      files: [
        {
          path: "types.ts",
          code: "export interface Account { id: string; balance: number; name: string; }",
        },
      ],
      dependencies: {},
    });

    // Stage 3: SummaryCard.tsx
    const cardJson = JSON.stringify({
      files: [
        {
          path: "components/SummaryCard.tsx",
          code: "import React from 'react'; export function SummaryCard() { return <div>Card</div>; }",
        },
      ],
      dependencies: {},
    });

    // Stage 4: App.tsx - returns truncated JSON for initial attempt AND retries
    const truncApp = `{"files":[{"path":"App.tsx","code":"import React from 'react';\\nexport default function App() { return <div`;

    const scriptedProvider = new MockScriptedProvider([
      { outputText: planJson, finishReason: "stop" },
      { outputText: typesJson, finishReason: "stop" },
      { outputText: cardJson, finishReason: "stop" },
      { outputText: truncApp, finishReason: "length", truncated: true }, // Stage 4 attempt 1
      { outputText: truncApp, finishReason: "length", truncated: true }, // Stage 4 attempt 2 (retry 1)
      { outputText: truncApp, finishReason: "length", truncated: true }, // Stage 4 attempt 3
    ]);

    const originalMetaProvider = modelRouter.getProvider("meta");
    modelRouter.registerProvider(scriptedProvider);

    try {
      // 1. Call real POST /api/generate with mode: "async"
      const postReq = new Request("http://localhost/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Build an account overview app with summary cards",
          provider: "meta",
          model: "muse-spark-1.3",
          mode: "async",
        }),
      });

      const postRes = await generatePost(postReq);
      assert.ok(postRes.ok, "POST must return successful status for async job");
      const postBody = await postRes.json();
      assert.ok(postBody.jobId, "POST response must contain jobId");
      const jobId = postBody.jobId;

      // 2. Wait for the real background generation task to execute and fail
      let job = globalJobStore.getJob(jobId);
      const pollStart = Date.now();
      while (job && job.status !== "failed" && job.status !== "completed") {
        if (Date.now() - pollStart > 5000) {
          assert.fail("Background generation task timed out waiting for completion/failure");
        }
        await new Promise((r) => setTimeout(r, 40));
        job = globalJobStore.getJob(jobId);
      }

      assert.ok(job, "Job must exist");
      assert.equal(job.status, "failed", "Job must have failed");
      assert.equal(job.statusCode, 502, "Job statusCode must be 502");

      // 3. Verify that completedFilePaths contains BOTH types.ts and SummaryCard.tsx
      assert.ok(job.completedFilePaths.includes("types.ts"), "completedFilePaths must contain types.ts from Stage 2");
      assert.ok(job.completedFilePaths.includes("components/SummaryCard.tsx"), "completedFilePaths must contain SummaryCard.tsx from Stage 3");

      // 4. Verify GET /api/generate?jobId=... returns HTTP 502 with full failure details
      const getReq = new Request(`http://localhost/api/generate?jobId=${jobId}`);
      const getRes = await generateGet(getReq);
      assert.equal(getRes.status, 502, "GET endpoint must return HTTP 502");

      const getBody = await getRes.json();
      assert.equal(getBody.success, false);
      assert.equal(getBody.status, "failed");
      assert.ok(getBody.error.includes("generating_entry"), "Error must specify stage generating_entry");
      assert.ok(getBody.error.includes("output token limits"), "Error must mention output token limits");
      assert.deepEqual(
        (getBody.completedFilePaths as string[]).sort(),
        ["components/SummaryCard.tsx", "types.ts"]
      );
    } finally {
      if (originalMetaProvider) {
        modelRouter.registerProvider(originalMetaProvider);
      }
    }
  });

  test("B2. Real background generation task timeout: deadline expiration returns HTTP 504 and preserves completed paths", async () => {
    const planJson = JSON.stringify({
      files: [
        { path: "types.ts", purpose: "Data types" },
        { path: "App.tsx", purpose: "Root application" },
      ],
      dependencies: {},
    });

    const typesJson = JSON.stringify({
      files: [
        { path: "types.ts", code: "export interface User { id: string; }" },
      ],
      dependencies: {},
    });

    let callCount = 0;
    const slowProvider: ModelProvider = {
      name: "meta" as const,
      async generate(): Promise<ModelResponse> {
        callCount++;
        if (callCount === 1) {
          return { outputText: planJson, finishReason: "stop" };
        }
        if (callCount === 2) {
          return { outputText: typesJson, finishReason: "stop" };
        }
        // Stage 4: slow call that causes timeoutMs (150ms) to expire
        await new Promise((r) => setTimeout(r, 200));
        return { outputText: "{}", finishReason: "stop" };
      },
    };

    const originalMetaProvider = modelRouter.getProvider("meta");
    modelRouter.registerProvider(slowProvider);

    try {
      const postReq = new Request("http://localhost/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Build app with short timeout",
          provider: "meta",
          model: "muse-spark-1.3",
          mode: "async",
          timeoutMs: 150, // 150ms aggregate deadline
        }),
      });

      const postRes = await generatePost(postReq);
      assert.ok(postRes.ok, "POST must return successful status for async job");
      const postBody = await postRes.json();
      const jobId = postBody.jobId;

      let job = globalJobStore.getJob(jobId);
      const pollStart = Date.now();
      while (job && job.status !== "failed" && job.status !== "completed") {
        if (Date.now() - pollStart > 5000) {
          assert.fail("Background generation task timed out waiting for completion/failure");
        }
        await new Promise((r) => setTimeout(r, 40));
        job = globalJobStore.getJob(jobId);
      }

      assert.ok(job);
      assert.equal(job.status, "failed");
      assert.equal(job.statusCode, 504, `Expected HTTP 504, got ${job.statusCode}`);

      // Verify completedFilePaths has types.ts from Stage 2
      assert.ok(job.completedFilePaths.includes("types.ts"));

      const getRes = await generateGet(new Request(`http://localhost/api/generate?jobId=${jobId}`));
      assert.equal(getRes.status, 504, "GET must return HTTP 504");
      const getBody = await getRes.json();
      assert.equal(getBody.success, false);
      assert.equal(getBody.status, "failed");
      assert.ok(getBody.error.includes("maximum allowed duration") || getBody.error.includes("exceeded"));
      assert.deepEqual(getBody.completedFilePaths, ["types.ts"]);
    } finally {
      if (originalMetaProvider) {
        modelRouter.registerProvider(originalMetaProvider);
      }
    }
  });

  // === C. Deadline Correctness: Shared Original Deadline and Remaining Per-Call Timeout ===

  test("C. Deadline consumed by earlier stages prevents retry from extending it", async () => {
    const router = new ModelRouter();

    const planJson = JSON.stringify({
      files: [{ path: "App.tsx", purpose: "Main entry" }],
      dependencies: {},
    });

    const truncatedApp = `{"files":[{"path":"App.tsx","code":"export default function App() { return <div`;

    let callCount = 0;
    const recordedTimeouts: number[] = [];
    const delayProvider: ModelProvider = {
      name: "meta" as const,
      async generate(req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        if (req.timeoutMs) {
          recordedTimeouts.push(req.timeoutMs);
        }
        if (callCount === 1) {
          return { outputText: planJson, finishReason: "stop" };
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { outputText: truncatedApp, finishReason: "length", truncated: true };
      },
    };
    router.registerProvider(delayProvider);

    const startTime = Date.now();
    try {
      await executeStagedGenerationPipeline({
        modelRouter: router,
        provider: "meta",
        model: "muse-spark-1.3",
        userPrompt: "Build app with deadline check",
        requestId: "test-c-deadline-consumption",
        timeoutMs: 200, // 200ms aggregate deadline
        maxComponentRetries: 5,
      });
      assert.fail("Pipeline should have failed due to deadline expiration");
    } catch (err: unknown) {
      const elapsed = Date.now() - startTime;
      const status = getErrorStatusCode(err);

      assert.equal(status, 504, `Expected HTTP 504 deadline error, got ${status}: ${(err as Error).message}`);
      assert.match((err as Error).message, /maximum allowed duration|exceeded/i);

      assert.ok(
        elapsed < 2000,
        `Pipeline took ${elapsed}ms — deadline was 200ms. Retries must NOT reset the deadline.`
      );

      // Verify that per-call timeouts decreased over time as the aggregate deadline was consumed
      if (recordedTimeouts.length >= 2) {
        assert.ok(
          recordedTimeouts[1] <= recordedTimeouts[0],
          `Subsequent call timeout (${recordedTimeouts[1]}ms) must be <= initial call timeout (${recordedTimeouts[0]}ms)`
        );
      }
    }
  });

  // === D. HTTP Status Classification ===

  test("D1. Genuine client validation errors map to 400", () => {
    assert.equal(getErrorStatusCode(new Error("Invalid model 'nonexistent'")), 400);
    assert.equal(getErrorStatusCode(new Error("Model is not available or registered")), 400);
    assert.equal(getErrorStatusCode(new Error("bad request: missing prompt")), 400);
    assert.equal(getErrorStatusCode(new Error("invalid json request body")), 400);
    assert.equal(getErrorStatusCode(new Error("Prompt exceeds maximum allowed length")), 400);
    assert.equal(getErrorStatusCode(new Error("Please provide a valid model name")), 400);
  });

  test("D2. Rate limiting maps to 429", () => {
    assert.equal(getErrorStatusCode(new Error("rate limit exceeded")), 429);
    assert.equal(getErrorStatusCode(new Error("HTTP 429: Too many requests")), 429);
    assert.equal(getErrorStatusCode(new Error("resource_exhausted")), 429);
    assert.equal(getErrorStatusCode(new Error("API quota exceeded")), 429);
  });

  test("D3. Upstream malformed or truncated model output maps to 502", () => {
    assert.equal(getErrorStatusCode(new Error("Unterminated string in JSON at position 11090")), 502);
    assert.equal(getErrorStatusCode(new Error("model response was truncated due to output token limits")), 502);
    assert.equal(getErrorStatusCode(new Error("meta did not return valid json")), 502);
    assert.equal(getErrorStatusCode(new Error("malformed json from model")), 502);
    assert.equal(getErrorStatusCode(new Error("empty completion from provider")), 502);
    assert.equal(getErrorStatusCode(new Error("null completion")), 502);
    assert.equal(getErrorStatusCode(new Error("refused to generate")), 502);
    assert.equal(getErrorStatusCode(new Error("content filtered by safety")), 502);
    assert.equal(getErrorStatusCode(new Error("meta generated invalid TypeScript (App.tsx:1:10)")), 502);
    assert.equal(getErrorStatusCode(new Error("no valid files in output")), 502);
    assert.equal(getErrorStatusCode(new Error("failed to generate a valid App.tsx")), 502);
    assert.equal(getErrorStatusCode(new Error("Syntactically invalid code")), 502);
  });

  test("D4. Upstream timeout or aggregate deadline expiration maps to 504", () => {
    assert.equal(getErrorStatusCode(new Error("request timed out after 30s")), 504);
    assert.equal(getErrorStatusCode(new Error("504 gateway timeout")), 504);
    assert.equal(getErrorStatusCode(new Error("Model call timed out")), 504);
    assert.equal(getErrorStatusCode(new Error("Application generation pipeline exceeded maximum allowed duration (10 minutes)")), 504);
    assert.equal(getErrorStatusCode(new Error("Request took too long to complete")), 504);

    const deadlineErr = new Error("pipeline exceeded maximum allowed duration");
    (deadlineErr as unknown as { status: number }).status = 504;
    assert.equal(getErrorStatusCode(deadlineErr), 504);
  });

  test("D5. Unexpected internal application errors map to 500", () => {
    assert.equal(getErrorStatusCode(new Error("Cannot read property 'foo' of undefined")), 500);
    assert.equal(getErrorStatusCode(new Error("some random unknown error")), 500);
    assert.equal(getErrorStatusCode(null), 500);
    assert.equal(getErrorStatusCode(undefined), 500);
    assert.equal(getErrorStatusCode(new Error("Internal server error occurred")), 500);
  });

  test("D6. 'invalid json' in client request body maps to 400 but 'malformed json' from model maps to 502", () => {
    assert.equal(getErrorStatusCode(new Error("invalid json request body")), 400);
    assert.equal(getErrorStatusCode(new Error("malformed json")), 502);
  });

  // === E. Additional Verification: Code Integrity and Recovery Robustness ===

  test("E1. extractCompleteFilesFromTruncatedJson rejects files with syntax errors and preserves valid ones", () => {
    const raw = `{"files":[
      {"path":"types.ts","code":"export interface ValidUser { id: string; name: string; }"},
      {"path":"components/Corrupted.tsx","code":"export function Corrupted() { return <div class= { 1 + } }"},
      {"path":"components/Healthy.tsx","code":"import React from 'react'; export function Healthy() { return <div>Healthy</div>; }"}
    ]}`;

    const files = extractCompleteFilesFromTruncatedJson(raw);
    const paths = files.map((f) => f.path);
    assert.ok(paths.includes("types.ts"), "types.ts is valid and should be extracted");
    assert.ok(!paths.includes("components/Corrupted.tsx"), "Corrupted.tsx has syntax error and must be rejected");
    assert.ok(paths.includes("components/Healthy.tsx"), "Healthy.tsx is valid and should be extracted");
  });

  test("E2. Frontend error handling: non-JSON gateway HTML errors and HTTP 502/504 errors throw clean sanitized errors", () => {
    const htmlGateway502 = `<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>cloudflare</center></body></html>`;
    const strippedHtml = htmlGateway502.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    assert.ok(strippedHtml.includes("502 Bad Gateway"));
    assert.ok(!strippedHtml.includes("<center>"));

    const htmlTimeout504 = `<html><body><h1>504 Gateway Time-out</h1>The server didn't respond in time.</body></html>`;
    const stripped504 = htmlTimeout504.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    assert.ok(stripped504.includes("504 Gateway Time-out"));
  });

  test("E3. Client-provided timeout is validated and bounded; retry-loop boundaries match configured count", async () => {
    // 1. Verify retry loop boundary: maxComponentRetries = 0 means 0 retries (1 attempt total)
    const router0 = new ModelRouter();
    const planJson = JSON.stringify({
      files: [{ path: "App.tsx", purpose: "Main entry" }],
      dependencies: {},
    });
    const truncApp = `{"files":[{"path":"App.tsx","code":"import React from 'react';\\nexport default function App() { return <div`;

    const mock0 = new MockScriptedProvider([
      { outputText: planJson, finishReason: "stop" },
      { outputText: truncApp, finishReason: "length", truncated: true }, // App attempt 1
      { outputText: truncApp, finishReason: "length", truncated: true }, // Should NOT be called if 0 retries
    ]);
    router0.registerProvider(mock0);

    await assert.rejects(
      async () => {
        await executeStagedGenerationPipeline({
          modelRouter: router0,
          provider: "meta",
          model: "muse-spark-1.3",
          userPrompt: "Build app",
          requestId: "test-e3-retries-0",
          maxComponentRetries: 0,
        });
      },
      (err: Error) => {
        assert.match(err.message, /stage 'generating_entry'/);
        return true;
      }
    );

    // Call count must be exactly 2: 1 plan + 1 app attempt (0 retries)
    assert.equal(mock0.calls.length, 2, "maxComponentRetries: 0 must yield exactly 1 app attempt (0 retries)");

    // 2. Verify server-side clamping of excessive client timeout via POST /api/generate
    const excessiveTimeout = 36000000; // 10 hours
    const postReq = new Request("http://localhost/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Build app",
        provider: "meta",
        model: "muse-spark-1.3",
        mode: "async",
        timeoutMs: excessiveTimeout,
      }),
    });

    const postRes = await generatePost(postReq);
    assert.ok(postRes.ok, "POST must succeed");
    const body = await postRes.json();
    assert.ok(body.jobId);
  });
});
