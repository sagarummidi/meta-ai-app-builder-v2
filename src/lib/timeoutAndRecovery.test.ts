import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MetaProvider,
  resolveProviderTimeoutMs,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  ModelRouter,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "./modelRouter";
import {
  executeGenerationPipeline,
  findMissingLocalImports,
  findTruncatedFileInOutput,
  resolveRelativeImportPath,
  isImportPathSatisfied,
  extractCompleteFilesFromTruncatedJson,
} from "./jsonRecovery";

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
      throw new Error("MockScriptedProvider: No more responses configured.");
    }
    return resp;
  }
}

describe("Timeout & Recovery Hardening: Provider Timeout Configuration & Handling", () => {
  test("resolveProviderTimeoutMs respects DEFAULT_PROVIDER_TIMEOUT_MS and environment override", () => {
    const origMetaEnv = process.env.META_TIMEOUT_MS;
    const origAiEnv = process.env.AI_PROVIDER_TIMEOUT_MS;
    const origModelEnv = process.env.MODEL_TIMEOUT_MS;

    try {
      delete process.env.META_TIMEOUT_MS;
      delete process.env.AI_PROVIDER_TIMEOUT_MS;
      delete process.env.MODEL_TIMEOUT_MS;
      assert.equal(resolveProviderTimeoutMs(), DEFAULT_PROVIDER_TIMEOUT_MS);
      assert.equal(resolveProviderTimeoutMs(), 180000);

      process.env.META_TIMEOUT_MS = "240000";
      assert.equal(resolveProviderTimeoutMs(), 240000);

      delete process.env.META_TIMEOUT_MS;
      process.env.AI_PROVIDER_TIMEOUT_MS = "210000";
      assert.equal(resolveProviderTimeoutMs(), 210000);

      process.env.AI_PROVIDER_TIMEOUT_MS = "invalid";
      assert.equal(resolveProviderTimeoutMs(), DEFAULT_PROVIDER_TIMEOUT_MS);
    } finally {
      if (origMetaEnv !== undefined) process.env.META_TIMEOUT_MS = origMetaEnv;
      else delete process.env.META_TIMEOUT_MS;

      if (origAiEnv !== undefined) process.env.AI_PROVIDER_TIMEOUT_MS = origAiEnv;
      else delete process.env.AI_PROVIDER_TIMEOUT_MS;

      if (origModelEnv !== undefined) process.env.MODEL_TIMEOUT_MS = origModelEnv;
      else delete process.env.MODEL_TIMEOUT_MS;
    }
  });

  test("MetaProvider successful response before timeout", async () => {
    const fastFetch = (async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: '{"files":[{"path":"App.tsx","code":"export default () => <div>Fast</div>;"}]}' },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const provider = new MetaProvider({
      apiKey: "meta-test-key",
      fetchFn: fastFetch,
    });

    const res = await provider.generate({
      input: "test fast prompt",
      timeoutMs: 5000,
    });

    assert.ok(res.outputText.includes("Fast"));
    assert.equal(res.truncated, false);
  });

  test("MetaProvider aborts on timeout with status 504 and clear message", async () => {
    const slowFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }) as unknown as typeof fetch;

    const provider = new MetaProvider({
      apiKey: "meta-test-timeout-key",
      fetchFn: slowFetch,
    });

    await assert.rejects(
      async () => {
        await provider.generate({
          input: "test slow prompt",
          timeoutMs: 50, // 50ms fast timeout for testing
        });
      },
      (err: Error & { status?: number; statusCode?: number }) => {
        assert.equal(err.status, 504);
        assert.equal(err.statusCode, 504);
        assert.match(err.message, /Meta API request timed out after/i);
        return true;
      }
    );
  });

  test("Distinguishes real network errors (status 503) from timeouts (status 504)", async () => {
    const networkFailFetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.meta.ai");
    }) as unknown as typeof fetch;

    const provider = new MetaProvider({
      apiKey: "meta-mock-key",
      fetchFn: networkFailFetch,
    });

    await assert.rejects(
      async () => {
        await provider.generate({ input: "test" });
      },
      (err: Error & { status?: number; statusCode?: number }) => {
        assert.equal(err.status, 503);
        assert.equal(err.statusCode, 503);
        assert.match(err.message, /network request failed/i);
        return true;
      }
    );
  });

  test("AbortController timer is properly cleaned up on fast response", async () => {
    let timerCleared = false;
    const origClearTimeout = globalThis.clearTimeout;

    // Spy on clearTimeout
    globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
      timerCleared = true;
      return origClearTimeout(id);
    }) as typeof clearTimeout;

    try {
      const fastFetch = (async () => {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: '{"files":[{"path":"App.tsx","code":"export default () => <div>Done</div>;"}]}' },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as unknown as typeof fetch;

      const provider = new MetaProvider({
        apiKey: "meta-test-key",
        fetchFn: fastFetch,
      });

      await provider.generate({ input: "cleanup test" });
      assert.equal(timerCleared, true);
    } finally {
      globalThis.clearTimeout = origClearTimeout;
    }
  });
});

describe("Timeout & Recovery Hardening: Import Resolution & Completeness Detection", () => {
  test("resolveRelativeImportPath correctly resolves relative sibling and parent imports", () => {
    assert.equal(
      resolveRelativeImportPath("App.tsx", "./components/Card"),
      "components/Card"
    );
    assert.equal(
      resolveRelativeImportPath("components/Card.tsx", "../types"),
      "types"
    );
    assert.equal(
      resolveRelativeImportPath("components/Card.tsx", "./Button"),
      "components/Button"
    );
    assert.equal(
      resolveRelativeImportPath("App.tsx", "react"),
      null // external package
    );
    assert.equal(
      resolveRelativeImportPath("App.tsx", "lucide-react"),
      null // external package
    );
  });

  test("isImportPathSatisfied recognizes various candidate extensions", () => {
    const existing = new Set(["components/Card.tsx", "types.ts", "utils/index.ts"]);
    assert.equal(isImportPathSatisfied("components/Card", existing), true);
    assert.equal(isImportPathSatisfied("types", existing), true);
    assert.equal(isImportPathSatisfied("utils", existing), true);
    assert.equal(isImportPathSatisfied("components/Modal", existing), false);
  });

  test("findMissingLocalImports correctly detects missing components", () => {
    const files = [
      {
        path: "App.tsx",
        code: `
          import React from 'react';
          import { Header } from './components/Header';
          import { Footer } from './components/Footer';
          import { User } from './types';
          export default function App() { return <div>App</div>; }
        `,
      },
      {
        path: "components/Header.tsx",
        code: "export function Header() { return <header>Header</header>; }",
      },
      {
        path: "types.ts",
        code: "export interface User { id: string; name: string; }",
      },
    ];

    const missing = findMissingLocalImports(files);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].missingPath, "components/Footer.tsx");
    assert.equal(missing[0].importedBy, "App.tsx");
    assert.match(missing[0].importStatement, /import.*Footer.*from/);
  });

  test("findTruncatedFileInOutput detects in-flight unclosed files", () => {
    const partialRaw = `{"files":[
      {"path":"App.tsx","code":"export default function App() { return <div>App</div>; }"},
      {"path":"components/Dashboard.tsx","code":"export default function Dashboard() { return <div
    `;
    const completed = [
      {
        path: "App.tsx",
        code: "export default function App() { return <div>App</div>; }",
      },
    ];

    const cutOff = findTruncatedFileInOutput(partialRaw, completed);
    assert.equal(cutOff, "components/Dashboard.tsx");
  });
});

describe("Timeout & Recovery Hardening: Generation Pipeline Optimization", () => {
  test("Fast path: successful complete generation returns in 1 turn without continuation", async () => {
    const router = new ModelRouter();
    const mockProvider = new MockScriptedProvider([
      {
        outputText: JSON.stringify({
          files: [
            {
              path: "App.tsx",
              code: "export default function App() { return <div>Fast Path Success</div>; }",
            },
          ],
          dependencies: {},
        }),
        finishReason: "stop",
        truncated: false,
      },
    ]);
    router.registerProvider(mockProvider);

    const result = await executeGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build a single page counter",
      requestId: "test-fast-path",
    });

    assert.equal(result.attemptsUsed, 1);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, "App.tsx");
    assert.equal(mockProvider.calls.length, 1);
    assert.ok(result.timings);
    assert.equal(result.timings.modelCallsCount, 1);
    assert.ok(result.timings.totalDurationMs >= 0);
  });

  test("Truncation with self-contained app skips unnecessary continuation", async () => {
    const router = new ModelRouter();
    const turn1Output = `{"files":[{"path":"App.tsx","code":"export default function App() { return <div>Self Contained</div>; }"}]`;

    const mockProvider = new MockScriptedProvider([
      {
        outputText: turn1Output,
        finishReason: "length",
        truncated: true,
      },
    ]);
    router.registerProvider(mockProvider);

    const result = await executeGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build simple app",
      requestId: "test-skip-unneeded-continuation",
    });

    assert.equal(result.attemptsUsed, 1);
    assert.equal(result.files.length, 1);
    assert.equal(mockProvider.calls.length, 1);
  });

  test("Targeted continuation includes missing file context and succeeds on turn 2", async () => {
    const router = new ModelRouter();
    const turn1Output = `{"files":[
      {"path":"App.tsx","code":"import { Widget } from './components/Widget';\\nexport default function App() { return <Widget />; }"},
      {"path":"components/Widget.tsx","code":"export function Widget() { return <div"
    `;

    const turn2Output = JSON.stringify({
      files: [
        {
          path: "components/Widget.tsx",
          code: "export function Widget() { return <div>Working Widget</div>; }",
        },
      ],
      dependencies: { "lucide-react": "latest" },
    });

    const mockProvider = new MockScriptedProvider([
      {
        outputText: turn1Output,
        finishReason: "length",
        truncated: true,
      },
      {
        outputText: turn2Output,
        finishReason: "stop",
        truncated: false,
      },
    ]);
    router.registerProvider(mockProvider);

    const result = await executeGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build widget app",
      requestId: "test-targeted-continuation",
    });

    assert.equal(result.attemptsUsed, 2);
    assert.equal(result.files.length, 2);
    assert.ok(result.files.find((f) => f.path === "App.tsx"));
    assert.ok(result.files.find((f) => f.path === "components/Widget.tsx"));
    assert.equal(result.dependencies["lucide-react"], "latest");
    assert.equal(mockProvider.calls.length, 2);

    const continuationInput = mockProvider.calls[1].input;
    assert.match(continuationInput, /components\/Widget\.tsx/);
    assert.match(continuationInput, /Already generated and saved files/);
    assert.match(continuationInput, /Do NOT repeat, rewrite, or regenerate/);

    assert.equal(result.timings.modelCallsCount, 2);
    assert.equal(result.timings.finalFilesCount, 2);
    assert.ok(result.timings.initialRequestDurationMs >= 0);
    assert.ok(result.timings.continuationDurationMs >= 0);
  });

  test("Safely rejects syntactically invalid TypeScript even during recovery", () => {
    const rawBroken = `{"files":[
      {"path":"App.tsx","code":"export default function App() { return <div>Unclosed JSX; }"}
    ]}`;

    const files = extractCompleteFilesFromTruncatedJson(rawBroken);
    assert.equal(files.length, 0);
  });

  test("Limit continuation to a maximum of two additional attempts", async () => {
    const router = new ModelRouter();
    // 3 truncated responses (1 initial + 2 continuations = 3 attempts total)
    const mockProvider = new MockScriptedProvider([
      { outputText: '{"files":[{"path":"App.tsx","code":"const x = <div', finishReason: "length", truncated: true },
      { outputText: '{"files":[{"path":"App.tsx","code":"const x = <div', finishReason: "length", truncated: true },
      { outputText: '{"files":[{"path":"App.tsx","code":"const x = <div', finishReason: "length", truncated: true },
    ]);
    router.registerProvider(mockProvider);

    await assert.rejects(
      async () => {
        await executeGenerationPipeline({
          modelRouter: router,
          provider: "meta",
          model: "muse-spark-1.3",
          userPrompt: "Test max 2 continuation attempts",
          requestId: "test-max-2",
          maxContinuationAttempts: 2,
        });
      },
      (err: Error) => {
        assert.match(err.message, /could not be recovered after 3 attempts/i);
        return true;
      }
    );
    assert.equal(mockProvider.calls.length, 3);
  });
});
