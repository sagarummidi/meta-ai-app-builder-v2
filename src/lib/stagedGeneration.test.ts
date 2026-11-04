import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  executeStagedGenerationPipeline,
  findMissingLocalImports,
  findFirstSyntaxError,
} from "./jsonRecovery";
import {
  ModelRouter,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  getErrorStatusCode,
} from "./modelRouter";
import { globalJobStore } from "./generationJobs";
import { POST as generatePost, GET as generateGet } from "../app/api/generate/route";
import { SlidingWindowRateLimiter } from "./rateLimiter";

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
      throw new Error(`ScriptedMockProvider: No more responses configured for call ${this.calls.length}.`);
    }
    return resp;
  }
}

describe("Staged Multi-File Generation & Async Job Workflow", () => {
  test("1. Successful small application generation (single App.tsx)", async () => {
    const router = new ModelRouter();
    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        plan: "Simple click counter button",
        files: [{ path: "App.tsx", purpose: "Main counter" }],
        dependencies: {},
      }),
      finishReason: "stop",
    };

    const appResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          {
            path: "App.tsx",
            code: "import React, { useState } from 'react'; export default function App() { const [c, setC] = useState(0); return <button onClick={() => setC(c + 1)}>Count: {c}</button>; }",
          },
        ],
        dependencies: {},
      }),
      finishReason: "stop",
    };

    router.registerProvider(new ScriptedMockProvider([planResponse, appResponse]));

    const progressLogs: string[] = [];
    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build a counter button",
      requestId: "test-small-app",
      onProgress: (stage) => progressLogs.push(stage),
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, "App.tsx");
    assert.match(result.files[0].code, /Count: \{c\}/);
    assert.equal(findFirstSyntaxError(result.files), null);
    assert.ok(progressLogs.some((l) => l.includes("Planning")));
    assert.ok(progressLogs.some((l) => l.includes("completed")));
  });

  test("2. Successful multi-file staged generation (types, component, and App.tsx)", async () => {
    const router = new ModelRouter();

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        plan: "Expense tracker with typed models and form",
        files: [
          { path: "types.ts", purpose: "Expense data types" },
          { path: "components/ExpenseForm.tsx", purpose: "Form component" },
          { path: "App.tsx", purpose: "Main application" },
        ],
        dependencies: { "lucide-react": "^0.300.0" },
      }),
      finishReason: "stop",
    };

    const typesResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          {
            path: "types.ts",
            code: "export interface Expense { id: string; title: string; amount: number; }",
          },
        ],
      }),
      finishReason: "stop",
    };

    const componentResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          {
            path: "components/ExpenseForm.tsx",
            code: "import React from 'react'; import { Expense } from '../types'; export function ExpenseForm({ onAdd }: { onAdd: (e: Expense) => void }) { return <form><input name='title'/></form>; }",
          },
        ],
      }),
      finishReason: "stop",
    };

    const appResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          {
            path: "App.tsx",
            code: "import React, { useState } from 'react'; import { Expense } from './types'; import { ExpenseForm } from './components/ExpenseForm'; export default function App() { const [items, setItems] = useState<Expense[]>([]); return <div><ExpenseForm onAdd={(e) => setItems([...items, e])} /></div>; }",
          },
        ],
      }),
      finishReason: "stop",
    };

    router.registerProvider(
      new ScriptedMockProvider([planResponse, typesResponse, componentResponse, appResponse])
    );

    const progressStages: string[] = [];
    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build an expense tracker",
      requestId: "test-staged-multi",
      onProgress: (stage) => progressStages.push(stage),
    });

    assert.equal(result.files.length, 3);
    assert.ok(result.files.find((f) => f.path === "types.ts"));
    assert.ok(result.files.find((f) => f.path === "components/ExpenseForm.tsx"));
    assert.ok(result.files.find((f) => f.path === "App.tsx"));
    assert.equal(result.dependencies["lucide-react"], "^0.300.0");
    assert.equal(findFirstSyntaxError(result.files), null);
    assert.equal(findMissingLocalImports(result.files).length, 0);
  });

  test("3. Truncated component response with successful retry recovery", async () => {
    const router = new ModelRouter();

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        plan: "App with list",
        files: [
          { path: "components/List.tsx", purpose: "List component" },
          { path: "App.tsx", purpose: "Root App" },
        ],
      }),
      finishReason: "stop",
    };

    // Component turn 1 truncated
    const truncatedComponentResponse: ModelResponse = {
      outputText: '{"files":[{"path":"components/List.tsx","code":"export function List() { return <ul><li',
      finishReason: "length",
      truncated: true,
    };

    // Component turn 2 retry succeeds
    const recoveredComponentResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          {
            path: "components/List.tsx",
            code: "import React from 'react'; export function List() { return <ul><li>Item 1</li></ul>; }",
          },
        ],
      }),
      finishReason: "stop",
    };

    const appResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          {
            path: "App.tsx",
            code: "import React from 'react'; import { List } from './components/List'; export default function App() { return <div><List/></div>; }",
          },
        ],
      }),
      finishReason: "stop",
    };

    router.registerProvider(
      new ScriptedMockProvider([
        planResponse,
        truncatedComponentResponse,
        recoveredComponentResponse,
        appResponse,
      ])
    );

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build app with item list",
      requestId: "test-trunc-retry",
    });

    assert.equal(result.files.length, 2);
    assert.ok(result.files.find((f) => f.path === "components/List.tsx"));
    assert.equal(findFirstSyntaxError(result.files), null);
  });

  test("4. Preserves already completed files without unnecessary regeneration", async () => {
    const router = new ModelRouter();

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          { path: "types.ts", purpose: "Interfaces" },
          { path: "components/Card.tsx", purpose: "Card" },
          { path: "App.tsx", purpose: "App" },
        ],
      }),
    };

    const typesCode = "export interface CardData { title: string; uniqueId: 'ORIGINAL_TYPES'; }";
    const typesResponse: ModelResponse = {
      outputText: JSON.stringify({ files: [{ path: "types.ts", code: typesCode }] }),
    };

    const cardResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          {
            path: "components/Card.tsx",
            code: "import React from 'react'; import { CardData } from '../types'; export function Card({ data }: { data: CardData }) { return <h3>{data.title}</h3>; }",
          },
        ],
      }),
    };

    const appResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          {
            path: "App.tsx",
            code: "import React from 'react'; import { Card } from './components/Card'; export default function App() { return <Card data={{ title: 'T', uniqueId: 'ORIGINAL_TYPES' }}/>; }",
          },
        ],
      }),
    };

    const provider = new ScriptedMockProvider([planResponse, typesResponse, cardResponse, appResponse]);
    router.registerProvider(provider);

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Card app",
      requestId: "test-preserve-completed",
    });

    const typesFile = result.files.find((f) => f.path === "types.ts");
    assert.equal(typesFile?.code, typesCode);
  });

  test("5. Bounded retries prevents infinite generation loop", async () => {
    const router = new ModelRouter();

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          { path: "components/Bad.tsx", purpose: "Fails" },
          { path: "App.tsx", purpose: "App" },
        ],
      }),
    };

    // Both initial and retry fail with broken JSON
    const failResp1: ModelResponse = { outputText: "{ broken", finishReason: "stop" };
    const failResp2: ModelResponse = { outputText: "{ still broken", finishReason: "stop" };

    const appResp: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "App.tsx", code: "export default function App() { return <div>App</div>; }" }],
      }),
    };

    const provider = new ScriptedMockProvider([planResponse, failResp1, failResp2, appResp]);
    router.registerProvider(provider);

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "App with failing component",
      requestId: "test-bounded-retry",
      maxComponentRetries: 1,
    });

    // Bounded retries exits cleanly, App.tsx exists
    assert.ok(result.files.find((f) => f.path === "App.tsx"));
    assert.equal(provider.calls.length, 4); // Plan + 2 attempts for Bad.tsx + App.tsx
  });

  test("6. Targeted repair stage detects and generates missing local relative imports", async () => {
    const router = new ModelRouter();

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [{ path: "App.tsx", purpose: "App" }],
      }),
    };

    // App.tsx imports ./components/Footer, which was not originally planned
    const appResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          {
            path: "App.tsx",
            code: "import React from 'react'; import { Footer } from './components/Footer'; export default function App() { return <div><Footer/></div>; }",
          },
        ],
      }),
    };

    // Targeted repair generates components/Footer.tsx
    const repairResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          {
            path: "components/Footer.tsx",
            code: "import React from 'react'; export function Footer() { return <footer>Footer Info</footer>; }",
          },
        ],
      }),
    };

    router.registerProvider(new ScriptedMockProvider([planResponse, appResponse, repairResponse]));

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "App with missing footer import",
      requestId: "test-missing-import-repair",
    });

    assert.equal(result.files.length, 2);
    assert.ok(result.files.find((f) => f.path === "components/Footer.tsx"));
    assert.equal(findMissingLocalImports(result.files).length, 0);
  });

  test("7. Syntactic error detection rejects broken code before completion", async () => {
    const router = new ModelRouter();

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({ files: [{ path: "App.tsx", purpose: "App" }] }),
    };

    // App.tsx has unclosed JSX
    const brokenAppResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          {
            path: "App.tsx",
            code: "export default function App() { return <div><span>Unclosed; }",
          },
        ],
      }),
    };

    router.registerProvider(new ScriptedMockProvider([planResponse, brokenAppResponse]));

    await assert.rejects(
      async () => {
        await executeStagedGenerationPipeline({
          modelRouter: router,
          provider: "meta",
          model: "muse-spark-1.3",
          userPrompt: "Broken app",
          requestId: "test-syntax-fail",
        });
      },
      (err: Error) => {
        assert.match(err.message, /invalid TypeScript/i);
        return true;
      }
    );
  });

  test("8. Backend timeout handling and error mapping (HTTP 504)", () => {
    const timeoutErr = new Error("Meta API request timed out after 180s.");
    assert.equal(getErrorStatusCode(timeoutErr), 504);

    const truncErr = new Error("Response was truncated due to output token limits.");
    assert.equal(getErrorStatusCode(truncErr), 502);

    const netErr = new Error("Meta API network request failed: getaddrinfo ENOTFOUND");
    assert.equal(getErrorStatusCode(netErr), 503);
  });

  test("9. Async generation job flow: POST returns jobId quickly, GET returns progress and result", async () => {
    globalJobStore.clear();

    const testJob = globalJobStore.createJob("job-test-1", "A simple calculator", "meta", "muse-spark-1.3");
    assert.equal(testJob.id, "job-test-1");
    assert.equal(testJob.status, "pending");

    // Poll GET /api/generate?jobId=job-test-1 while pending
    const reqGetPending = new Request("http://localhost/api/generate?jobId=job-test-1", {
      method: "GET",
    });
    const resPending = await generateGet(reqGetPending);
    assert.equal(resPending.status, 200);
    const bodyPending = await resPending.json();
    assert.equal(bodyPending.status, "pending");

    // Update progress
    globalJobStore.updateJobProgress("job-test-1", {
      status: "generating_components",
      stageMessage: "Generating calculator keypad...",
      progressPercent: 50,
      completedFilePaths: ["types.ts"],
    });

    const resProgress = await generateGet(reqGetPending);
    const bodyProgress = await resProgress.json();
    assert.equal(bodyProgress.progressPercent, 50);
    assert.equal(bodyProgress.stageMessage, "Generating calculator keypad...");
    assert.deepEqual(bodyProgress.completedFilePaths, ["types.ts"]);

    // Complete job
    globalJobStore.completeJob("job-test-1", {
      files: [{ path: "App.tsx", code: "export default () => <div>Calc</div>;" }],
      dependencies: {},
      generatedCode: "export default () => <div>Calc</div>;",
      usedModel: "muse-spark-1.3",
      usedProvider: "meta",
      fallbackUsed: false,
    });

    const resCompleted = await generateGet(reqGetPending);
    const bodyCompleted = await resCompleted.json();
    assert.equal(bodyCompleted.status, "completed");
    assert.equal(bodyCompleted.progressPercent, 100);
    assert.equal(bodyCompleted.files.length, 1);
  });

  test("10. Duplicate / invalid generation requests handled cleanly", async () => {
    const emptyPromptReq = new Request("http://localhost/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });

    const res = await generatePost(emptyPromptReq);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /Please provide a prompt/);

    const missingJobGet = new Request("http://localhost/api/generate?jobId=non-existent-job-id", {
      method: "GET",
    });
    const resGet = await generateGet(missingJobGet);
    assert.equal(resGet.status, 404);
  });

  test("11. Rate limiter and concurrency controls preserved in async flow", async () => {
    const testLimiter = new SlidingWindowRateLimiter(
      {
        generate: { maxRequests: 1, windowMs: 10_000 },
        edit: { maxRequests: 5, windowMs: 10_000 },
        agent: { maxRequests: 5, windowMs: 10_000 },
        maxConcurrentModelCalls: 2,
      },
      () => 1000
    );

    const makeReq = () =>
      new Request("http://localhost/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "First request", mode: "async" }),
      });

    // 1st request succeeds and returns 200 with jobId
    const res1 = await generatePost(makeReq(), { rateLimiter: testLimiter });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.ok(body1.jobId);

    // 2nd request is blocked by rate limiter with 429
    const res2 = await generatePost(makeReq(), { rateLimiter: testLimiter });
    assert.equal(res2.status, 429);
  });

  test("12. Failed generation job reports clear, sanitized error information", async () => {
    globalJobStore.clear();

    const job = globalJobStore.createJob("job-fail-test", "Fail prompt", "meta", "muse-spark-1.3");
    globalJobStore.failJob(
      job.id,
      "Meta provider output validation failed: Syntactically invalid TypeScript (App.tsx:1:10).",
      502
    );

    const req = new Request("http://localhost/api/generate?jobId=job-fail-test", { method: "GET" });
    const res = await generateGet(req);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.status, "failed");
    assert.match(body.error, /Syntactically invalid TypeScript/);
  });
});
