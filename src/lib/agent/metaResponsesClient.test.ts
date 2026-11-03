import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MetaResponsesClient,
  executeResponsesRepair,
  RESPONSES_REPAIR_TOOLS,
} from "./metaResponsesClient";
import { VirtualWorkspace } from "./fileOps";
import { handleAgentRequest } from "./agentHandler";

describe("Meta Responses API: Request Construction & Authentication", () => {
  test("resolves default endpoint and base URL correctly", () => {
    const client = new MetaResponsesClient({ apiKey: "test-key" });
    const resolved = client.getResolvedEndpoint();
    assert.equal(resolved.endpoint, "https://api.meta.ai/v1/responses");
    assert.equal(resolved.baseUrl, "https://api.meta.ai/v1");
    assert.equal(resolved.apiKey, "test-key");

    const custom = new MetaResponsesClient({
      apiKey: "custom-key",
      baseUrl: "https://custom.api.meta.ai/v1/",
    });
    const customResolved = custom.getResolvedEndpoint();
    assert.equal(customResolved.endpoint, "https://custom.api.meta.ai/v1/responses");
    assert.equal(customResolved.baseUrl, "https://custom.api.meta.ai/v1");
  });

  test("missing MODEL_API_KEY throws 500 error", async () => {
    const originalKey = process.env.MODEL_API_KEY;
    delete process.env.MODEL_API_KEY;

    try {
      const client = new MetaResponsesClient();
      await assert.rejects(
        async () => {
          await client.sendResponseRequest({
            model: "muse-spark-1.3",
            input: "test",
          });
        },
        (err: Error) => {
          assert.equal(err.message, "MODEL_API_KEY is not configured.");
          assert.equal((err as unknown as { status: number }).status, 500);
          return true;
        }
      );
    } finally {
      if (originalKey !== undefined) process.env.MODEL_API_KEY = originalKey;
    }
  });

  test("constructs valid payload with Bearer token, tools, and reasoning effort", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      capturedBody = JSON.parse((init?.body as string) || "{}");

      return new Response(
        JSON.stringify({
          id: "resp_test_123",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: "No changes required.",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const client = new MetaResponsesClient({
      apiKey: "meta-responses-secret-token",
      fetchFn: mockFetch,
    });

    const res = await client.sendResponseRequest({
      model: "muse-spark-1.3",
      input: "Fix syntax",
      tools: RESPONSES_REPAIR_TOOLS,
      reasoning: { effort: "low" },
      previous_response_id: "resp_prev_999",
    });

    assert.equal(capturedUrl, "https://api.meta.ai/v1/responses");
    assert.equal(
      capturedHeaders["Authorization"],
      "Bearer meta-responses-secret-token"
    );
    assert.equal(capturedHeaders["Content-Type"], "application/json");
    assert.equal(capturedBody.model, "muse-spark-1.3");
    assert.equal(capturedBody.previous_response_id, "resp_prev_999");
    assert.deepEqual(capturedBody.reasoning, { effort: "low" });
    assert.ok(Array.isArray(capturedBody.tools));
    assert.equal((capturedBody.tools as unknown[]).length, 3);
    assert.equal(res.id, "resp_test_123");
  });
});

describe("Meta Responses API: Tool-Call Parsing & Execution", () => {
  test("successfully executes update_file tool call and resolves syntax errors", async () => {
    const brokenCode = `export default function App() {
  return (
    <div>
      <span>Broken
    </div>
  );
}`;

    const fixedCode = `export default function App() {
  return (
    <div>
      <span>Fixed</span>
    </div>
  );
}`;

    const ws = new VirtualWorkspace([{ path: "App.tsx", code: brokenCode }]);
    let requestCount = 0;

    const mockFetch = (async () => {
      requestCount++;

      if (requestCount === 1) {
        // Turn 1: Model issues a tool call to update App.tsx
        return new Response(
          JSON.stringify({
            id: "resp_turn_1",
            status: "completed",
            output: [
              {
                type: "function_call",
                id: "fc_001",
                call_id: "call_update_app_1",
                name: "update_file",
                arguments: JSON.stringify({
                  path: "App.tsx",
                  code: fixedCode,
                }),
              },
            ],
          }),
          { status: 200 }
        );
      }

      // Should not be needed because all errors are resolved in turn 1
      return new Response(
        JSON.stringify({
          id: "resp_turn_2",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: "Done" }],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const client = new MetaResponsesClient({
      apiKey: "meta-test-key",
      fetchFn: mockFetch,
    });

    const result = await executeResponsesRepair(ws, client, {
      model: "muse-spark-1.3",
      maxIterations: 3,
    });

    assert.equal(result.success, true);
    assert.equal(result.attempts, 1);
    assert.equal(result.remainingDiagnostics.length, 0);
    assert.ok(ws.readFile("App.tsx").includes("<span>Fixed</span>"));
    assert.equal(requestCount, 1);
  });

  test("verifies call_id matching across multi-turn continuations", async () => {
    const ws = new VirtualWorkspace([
      { path: "App.tsx", code: "export default function () { return <div><span></div>; }" },
      { path: "Button.tsx", code: "export function Button() { const x = ; return <button/>; }" },
    ]);

    let capturedSecondInput: unknown = null;
    let capturedSecondPrevId: string | undefined = undefined;
    let turnCount = 0;

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      turnCount++;
      const body = JSON.parse((init?.body as string) || "{}");

      if (turnCount === 1) {
        // Turn 1: Fix App.tsx, but leave Button.tsx for turn 2
        return new Response(
          JSON.stringify({
            id: "resp_turn_1",
            status: "completed",
            output: [
              {
                type: "function_call",
                id: "fc_1",
                call_id: "call_app_unique_id_101",
                name: "update_file",
                arguments: JSON.stringify({
                  path: "App.tsx",
                  code: "export default function () { return <div><span>Fixed App</span></div>; }",
                }),
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (turnCount === 2) {
        capturedSecondPrevId = body.previous_response_id;
        capturedSecondInput = body.input;

        // Turn 2: Fix Button.tsx
        return new Response(
          JSON.stringify({
            id: "resp_turn_2",
            status: "completed",
            output: [
              {
                type: "function_call",
                id: "fc_2",
                call_id: "call_btn_unique_id_202",
                name: "update_file",
                arguments: JSON.stringify({
                  path: "Button.tsx",
                  code: "export function Button() { const x = 42; return <button/>; }",
                }),
              },
            ],
          }),
          { status: 200 }
        );
      }

      return new Response(
        JSON.stringify({
          id: "resp_turn_3",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: "Completed" }],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const client = new MetaResponsesClient({
      apiKey: "meta-key",
      fetchFn: mockFetch,
    });

    const result = await executeResponsesRepair(ws, client, {
      model: "muse-spark-1.3",
      maxIterations: 3,
    });

    assert.equal(result.success, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.remainingDiagnostics.length, 0);

    // Verify turn 2 correctly continued with previous_response_id
    assert.equal(capturedSecondPrevId, "resp_turn_1");

    // Verify call_id matching in input to turn 2
    assert.ok(Array.isArray(capturedSecondInput));
    assert.equal((capturedSecondInput as Array<{ call_id?: string }>)[0].call_id, "call_app_unique_id_101");
  });
});

describe("Meta Responses API: Workspace Security & Rollback", () => {
  test("tool calls with path traversal or absolute paths are safely rejected without workspace mutation", async () => {
    const originalAppCode = "const broken = ;";
    const ws = new VirtualWorkspace([{ path: "App.tsx", code: originalAppCode }]);

    let toolOutputError = "";

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) || "{}");

      if (Array.isArray(body.input) && body.input[0]?.type === "function_call_output") {
        toolOutputError = body.input[0].output;
        return new Response(
          JSON.stringify({
            id: "resp_turn_2",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: "Gave up" }],
          }),
          { status: 200 }
        );
      }

      return new Response(
        JSON.stringify({
          id: "resp_turn_1",
          status: "completed",
          output: [
            {
              type: "function_call",
              id: "fc_traversal",
              call_id: "call_evil_path",
              name: "update_file",
              arguments: JSON.stringify({
                path: "../escaped.tsx",
                code: "const x = 1;",
              }),
            },
          ],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const client = new MetaResponsesClient({
      apiKey: "meta-key",
      fetchFn: mockFetch,
    });

    const result = await executeResponsesRepair(ws, client, { maxIterations: 3 });

    // Repair should fail because error was rejected and syntax error remained in App.tsx
    assert.equal(result.success, false);
    assert.equal(ws.readFile("App.tsx"), originalAppCode);
    assert.equal(ws.hasFile("../escaped.tsx"), false);
    assert.match(toolOutputError, /Path traversal/i);
  });

  test("stops immediately when repeated identical changes are detected (stagnation guard)", async () => {
    const brokenCode = "const bad = ;";
    const ws = new VirtualWorkspace([{ path: "App.tsx", code: brokenCode }]);
    let callCount = 0;

    const mockFetch = (async () => {
      callCount++;
      // Model repeatedly returns the EXACT same broken code
      return new Response(
        JSON.stringify({
          id: `resp_stagnant_${callCount}`,
          status: "completed",
          output: [
            {
              type: "function_call",
              id: `fc_${callCount}`,
              call_id: `call_${callCount}`,
              name: "update_file",
              arguments: JSON.stringify({
                path: "App.tsx",
                code: brokenCode,
              }),
            },
          ],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const client = new MetaResponsesClient({
      apiKey: "meta-key",
      fetchFn: mockFetch,
    });

    const result = await executeResponsesRepair(ws, client, { maxIterations: 3 });

    assert.equal(result.success, false);
    assert.equal(callCount, 1, "Should terminate after 1 turn upon detecting identical changes");
    assert.match(result.outcomeReason, /Repeated identical file changes detected/i);
  });

  test("strictly enforces maximum 3 tool iterations", async () => {
    const brokenCode = "const bad = ;";
    const ws = new VirtualWorkspace([{ path: "App.tsx", code: brokenCode }]);
    let callCount = 0;

    const mockFetch = (async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          id: `resp_turn_${callCount}`,
          status: "completed",
          output: [
            {
              type: "function_call",
              id: `fc_${callCount}`,
              call_id: `call_${callCount}`,
              name: "update_file",
              arguments: JSON.stringify({
                path: "App.tsx",
                code: `const bad = ; // attempt ${callCount}`,
              }),
            },
          ],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const client = new MetaResponsesClient({
      apiKey: "meta-key",
      fetchFn: mockFetch,
    });

    const result = await executeResponsesRepair(ws, client, { maxIterations: 3 });

    assert.equal(result.success, false);
    assert.equal(result.attempts, 3);
    assert.equal(callCount, 3, "Never exceeds 3 iterations");
    assert.match(result.outcomeReason, /maximum 3 tool iterations/i);
  });

  test("already valid workspace takes fast path with 0 calls", async () => {
    const ws = new VirtualWorkspace([
      { path: "App.tsx", code: "export default () => <div>Valid</div>;" },
    ]);
    let callCount = 0;

    const mockFetch = (async () => {
      callCount++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = new MetaResponsesClient({ apiKey: "key", fetchFn: mockFetch });
    const result = await executeResponsesRepair(ws, client);

    assert.equal(result.success, true);
    assert.equal(result.attempts, 0);
    assert.equal(callCount, 0);
    assert.match(result.outcomeReason, /already valid/i);
  });
});

describe("Meta Responses API: Error Handling & Secret Redaction", () => {
  test("handles 401 error cleanly with 401 status", async () => {
    const ws = new VirtualWorkspace([{ path: "App.tsx", code: "const bad = ;" }]);
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ error: { message: "Invalid key" } }), {
        status: 401,
      });
    }) as unknown as typeof fetch;

    const client = new MetaResponsesClient({ apiKey: "invalid-key", fetchFn: mockFetch });
    const result = await executeResponsesRepair(ws, client);

    assert.equal(result.success, false);
    assert.match(result.outcomeReason, /authentication failed \(401\)/i);
  });

  test("handles 429 rate limit cleanly with 429 status", async () => {
    const ws = new VirtualWorkspace([{ path: "App.tsx", code: "const bad = ;" }]);
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
        status: 429,
      });
    }) as unknown as typeof fetch;

    const client = new MetaResponsesClient({ apiKey: "key", fetchFn: mockFetch });
    const result = await executeResponsesRepair(ws, client);

    assert.equal(result.success, false);
    assert.match(result.outcomeReason, /rate limit exceeded \(429\)/i);
  });

  test("handles network failure cleanly with 503 status", async () => {
    const ws = new VirtualWorkspace([{ path: "App.tsx", code: "const bad = ;" }]);
    const mockFetch = (async () => {
      throw new Error("connect ECONNREFUSED api.meta.ai");
    }) as unknown as typeof fetch;

    const client = new MetaResponsesClient({ apiKey: "key", fetchFn: mockFetch });
    const result = await executeResponsesRepair(ws, client);

    assert.equal(result.success, false);
    assert.match(result.outcomeReason, /Meta Responses API network request failed/i);
  });

  test("redacts secret API keys from error messages", async () => {
    const ws = new VirtualWorkspace([{ path: "App.tsx", code: "const bad = ;" }]);
    const mockFetch = (async () => {
      return new Response(
        "Connection refused with Bearer secret-token-xyz-123456 and meta-secret-key-987",
        { status: 500 }
      );
    }) as unknown as typeof fetch;

    const client = new MetaResponsesClient({ apiKey: "key", fetchFn: mockFetch });
    const result = await executeResponsesRepair(ws, client);

    assert.equal(result.success, false);
    assert.equal(result.outcomeReason.includes("secret-token-xyz-123456"), false);
    assert.equal(result.outcomeReason.includes("meta-secret-key-987"), false);
    assert.match(result.outcomeReason, /\[REDACTED\]/);
  });
});

describe("Meta Responses API: Agent Route Integration", () => {
  test("POST /api/agent executes repair via Responses API when injected", async () => {
    const brokenCode = `export default function App() {
  return (
    <div>
      <span>Broken JSX
    </div>
  );
}`;

    const fixedCode = `export default function App() {
  return (
    <div>
      <span>Fixed JSX</span>
    </div>
  );
}`;

    const mockFetch = (async () => {
      return new Response(
        JSON.stringify({
          id: "resp_route_test_01",
          status: "completed",
          output: [
            {
              type: "function_call",
              id: "fc_route_1",
              call_id: "call_route_1",
              name: "update_file",
              arguments: JSON.stringify({
                path: "App.tsx",
                code: fixedCode,
              }),
            },
          ],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const responsesClient = new MetaResponsesClient({
      apiKey: "route-test-key",
      fetchFn: mockFetch,
    });

    const req = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "App.tsx", code: brokenCode }],
      }),
    });

    const res = await handleAgentRequest(req, { responsesClient });
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.repaired, true);
    assert.equal(data.attempts, 1);
    assert.equal(data.files[0].code, fixedCode);
    assert.equal(data.remainingDiagnostics.length, 0);
  });
});
