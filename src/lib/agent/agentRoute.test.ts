import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  handleAgentRequest as agentRoute,
  buildRepairPrompt,
  parseRepairOutput,
  createModelRouterRepairFunction,
} from "./agentHandler";
import { POST } from "../../app/api/agent/route";
import {
  ModelRouter,
  type ModelProvider,
  type ModelProviderType,
  type ModelRequest,
  type ModelResponse,
} from "../modelRouter";
import { type RepairAction } from "./repairLoop";

class MockProvider implements ModelProvider {
  name: ModelProviderType = "meta";
  public calls: ModelRequest[] = [];
  public mockResponse?: string;
  public mockError?: Error;

  constructor(name: ModelProviderType = "meta") {
    this.name = name;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    if (this.mockError) {
      throw this.mockError;
    }
    return {
      outputText:
        this.mockResponse ||
        JSON.stringify({
          changedFiles: [
            {
              path: "App.tsx",
              code: "export default function App() { return <div>Repaired</div>; }",
            },
          ],
        }),
    };
  }
}

describe("Agent API Route: Request Validation", () => {
  test("rejects invalid JSON request body with 400", async () => {
    const req = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{",
    });

    const res = await agentRoute(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.message, /invalid json/i);
  });

  test("exported POST handler delegates to handleAgentRequest", async () => {
    const req = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{",
    });

    const res = await POST(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.message, /invalid json/i);
  });

  test("rejects missing or empty files array with 400", async () => {
    const req1 = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res1 = await agentRoute(req1);
    assert.equal(res1.status, 400);

    const req2 = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [] }),
    });
    const res2 = await agentRoute(req2);
    assert.equal(res2.status, 400);
  });

  test("rejects files with empty or invalid path with 400", async () => {
    const req = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "   ", code: "export default () => {}" }],
      }),
    });

    const res = await agentRoute(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.message, /non-empty 'path' or 'name'/i);
  });

  test("rejects path traversal or absolute paths with 400", async () => {
    // 1. Path traversal
    const req1 = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "../escaped.tsx", code: "code" }],
      }),
    });
    const res1 = await agentRoute(req1);
    assert.equal(res1.status, 400);
    const data1 = await res1.json();
    assert.match(data1.message, /path traversal/i);

    // 2. Absolute path
    const req2 = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "/App.tsx", code: "code" }],
      }),
    });
    const res2 = await agentRoute(req2);
    assert.equal(res2.status, 400);
    const data2 = await res2.json();
    assert.match(data2.message, /absolute paths/i);
  });

  test("rejects unregistered provider or invalid model with 400", async () => {
    // Invalid provider
    const req1 = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "App.tsx", code: "export default () => {}" }],
        provider: "unsupported-provider",
      }),
    });
    const res1 = await agentRoute(req1);
    assert.equal(res1.status, 400);
    const data1 = await res1.json();
    assert.match(data1.message, /not available or registered/i);

    // Invalid model for valid provider
    const req2 = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "App.tsx", code: "export default () => {}" }],
        provider: "meta",
        model: "non-existent-meta-model",
      }),
    });
    const res2 = await agentRoute(req2);
    assert.equal(res2.status, 400);
    const data2 = await res2.json();
    assert.match(data2.message, /not available for provider/i);
  });
});

describe("Agent API Route: Clean Workspace Fast-Path", () => {
  test("valid workspace requires no repair and does not invoke repair function", async () => {
    let repairFnCalled = false;
    const req = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [
          {
            path: "App.tsx",
            code: "export default function App() { return <div>Clean Code</div>; }",
          },
        ],
      }),
    });

    const res = await agentRoute(req, {
      repairFn: async () => {
        repairFnCalled = true;
        return [];
      },
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.repaired, false);
    assert.equal(data.attempts, 0);
    assert.equal(data.remainingDiagnostics.length, 0);
    assert.equal(repairFnCalled, false, "Repair function must not be invoked when clean");
    assert.match(data.outcomeReason, /already valid/i);
  });
});

describe("Agent API Route: Mocked Repair Execution", () => {
  test("successfully repairs syntax errors using injected repair function", async () => {
    const brokenCode = `export default function App() {
  return (
    <div>
      <span>Missing closing tag
    </div>
  );
}`;

    const fixedCode = `export default function App() {
  return (
    <div>
      <span>Fixed closing tag</span>
    </div>
  );
}`;

    let callCount = 0;
    const mockRepair = async (): Promise<RepairAction[]> => {
      callCount++;
      return [{ type: "update", path: "App.tsx", code: fixedCode }];
    };

    const req = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "App.tsx", code: brokenCode }],
      }),
    });

    const res = await agentRoute(req, { repairFn: mockRepair });
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.repaired, true);
    assert.equal(data.attempts, 1);
    assert.equal(callCount, 1);
    assert.ok(data.initialDiagnostics.length > 0);
    assert.equal(data.remainingDiagnostics.length, 0);
    assert.equal(data.files[0].code, fixedCode);
  });

  test("returns failure status and remaining diagnostics after persistent errors across 2 attempts", async () => {
    const brokenCode = "const invalid = ;";
    let callCount = 0;

    const persistentBrokenRepair = async (): Promise<RepairAction[]> => {
      callCount++;
      return [{ type: "update", path: "App.tsx", code: `const invalid = ; // attempt ${callCount}` }];
    };

    const req = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "App.tsx", code: brokenCode }],
      }),
    });

    const res = await agentRoute(req, { repairFn: persistentBrokenRepair });
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.repaired, false);
    assert.equal(data.attempts, 2);
    assert.equal(callCount, 2);
    assert.ok(data.remainingDiagnostics.length > 0);
    assert.match(data.outcomeReason, /maximum 2 attempts/i);
  });

  test("handles repair function returning invalid operations safely without mutating workspace", async () => {
    const originalCode = "export default function () { return <div><span></div>; }";

    const invalidRepair = async (): Promise<RepairAction[]> => {
      return [{ type: "update", path: "NonExistent.tsx", code: "code" }];
    };

    const req = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "App.tsx", code: originalCode }],
      }),
    });

    const res = await agentRoute(req, { repairFn: invalidRepair });
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.outcomeReason, /Invalid file operations in repair batch/i);
    // Preserves original files
    assert.equal(data.files[0].path, "App.tsx");
    assert.equal(data.files[0].code, originalCode);
  });
});

describe("Agent API Route: Model Router Integration & Parser", () => {
  test("buildRepairPrompt formats diagnostics and files cleanly", () => {
    const files = [{ path: "App.tsx", code: "const x = ;" }];
    const diags = [
      {
        path: "App.tsx",
        line: 1,
        character: 11,
        column: 11,
        message: "Expression expected.",
        code: 1109,
        codeSnippet: "const x = ;",
      },
    ];

    const prompt = buildRepairPrompt(files, diags, 1);
    assert.ok(prompt.includes("File: App.tsx"));
    assert.ok(prompt.includes("const x = ;"));
    assert.ok(prompt.includes("Expression expected."));
    assert.ok(prompt.includes("TS1109"));
    assert.ok(prompt.includes("Attempt 1"));
  });

  test("parseRepairOutput extracts valid changedFiles from JSON and strips markdown fences", () => {
    const rawOutput = "```json\n{\n  \"changedFiles\": [\n    {\n      \"path\": \"App.tsx\",\n      \"code\": \"export default () => <div>Fixed</div>;\"\n    }\n  ]\n}\n```";
    const ops = parseRepairOutput(rawOutput);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].path, "App.tsx");
    assert.equal(ops[0].type, "update");
    if (ops[0].type === "update") {
      assert.equal(ops[0].code, "export default () => <div>Fixed</div>;");
    }
  });

  test("parseRepairOutput rejects malformed JSON cleanly", () => {
    assert.throws(() => parseRepairOutput("not-json"), /valid json/i);
    assert.throws(() => parseRepairOutput("{ broken: json }"), /Failed to parse/i);
    assert.throws(() => parseRepairOutput(JSON.stringify({ notChangedFiles: [] })), /must contain a 'changedFiles' array/i);
  });

  test("createModelRouterRepairFunction executes through MockProvider without live calls", async () => {
    const mockProvider = new MockProvider("meta");
    mockProvider.mockResponse = JSON.stringify({
      changedFiles: [
        {
          path: "App.tsx",
          code: "export default function App() { return <div>Repaired via MockRouter</div>; }",
        },
      ],
    });

    const router = new ModelRouter();
    router.registerProvider(mockProvider);

    const repairFn = createModelRouterRepairFunction({
      router,
      provider: "meta",
      model: "muse-spark-1.3",
      requestId: "test-req-1",
    });

    const ops = await repairFn({
      files: [{ path: "App.tsx", code: "const broken = ;" }],
      diagnostics: [
        {
          path: "App.tsx",
          line: 1,
          character: 1,
          column: 1,
          message: "Expression expected",
        },
      ],
      attempt: 1,
      maxAttempts: 2,
    });

    assert.equal(ops.length, 1);
    assert.equal(ops[0].path, "App.tsx");
    assert.ok("code" in ops[0] && ops[0].code.includes("Repaired via MockRouter"));
    assert.equal(mockProvider.calls.length, 1);
  });

  test("sanitizes error messages containing API secrets on failure", async () => {
    const mockProvider = new MockProvider("meta");
    mockProvider.mockError = new Error(
      "Provider authentication error: Invalid key meta-abcdef123456789 or Bearer secret_meta_token"
    );

    const router = new ModelRouter();
    router.registerProvider(mockProvider);

    const req = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "App.tsx", code: "const broken = ;" }],
        provider: "meta",
        disableFallback: true,
      }),
    });

    const res = await agentRoute(req, { router });
    const data = await res.json();

    assert.equal(data.success, false);
    // Keys must be sanitized
    assert.equal(data.message.includes("meta-abcdef123456789"), false);
    assert.equal(data.message.includes("secret_meta_token"), false);
    assert.ok(data.message.includes("[REDACTED]"));
  });

  test("maps provider status codes correctly (e.g. rate limit 429)", async () => {
    const mockProvider = new MockProvider("meta");
    const rateLimitError = new Error("Resource exhausted: 429 rate limit exceeded");
    (rateLimitError as unknown as { status: number }).status = 429;
    mockProvider.mockError = rateLimitError;

    const router = new ModelRouter();
    router.registerProvider(mockProvider);

    const req = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "App.tsx", code: "const broken = ;" }],
        provider: "meta",
        disableFallback: true,
      }),
    });

    const res = await agentRoute(req, { router });
    assert.equal(res.status, 429);
  });
});
