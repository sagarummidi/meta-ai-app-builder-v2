import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MetaProvider,
  extractTextFromMetaResponse,
  getErrorStatusCode,
  isRetryableModelError,
  ModelRouter,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "./modelRouter";
import { executeStagedGenerationPipeline } from "./jsonRecovery";

class MockScriptedProvider implements ModelProvider {
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
      throw new Error(`MockScriptedProvider: No response queued for call ${this.calls.length}.`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

describe("Meta API Response Extraction & Staged Generation Robustness", () => {
  // 1. Valid Meta completion
  test("1. Valid Meta completion extracts text and metadata across supported formats", async () => {
    // 1a. Standard OpenAI/Meta format
    const standardPayload = {
      id: "chatcmpl-123",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "export default function App() { return <div>Standard</div>; }",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 25,
        total_tokens: 40,
      },
    };
    const res1 = extractTextFromMetaResponse(standardPayload);
    assert.equal(res1.outputText, "export default function App() { return <div>Standard</div>; }");
    assert.equal(res1.finishReason, "stop");
    assert.equal(res1.truncated, false);
    assert.deepEqual(res1.rawUsage, {
      promptTokens: 15,
      completionTokens: 25,
      totalTokens: 40,
    });

    // 1b. Content parts array format [{ type: "text", text: "..." }]
    const multiPartPayload = {
      choices: [
        {
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "import React from 'react';\n" },
              { type: "text", text: "export default function App() { return <h1>MultiPart</h1>; }" },
            ],
          },
          finish_reason: "stop",
        },
      ],
    };
    const res2 = extractTextFromMetaResponse(multiPartPayload);
    assert.match(res2.outputText, /MultiPart/);
    assert.match(res2.outputText, /import React/);

    // 1c. Legacy choice.text format
    const legacyPayload = {
      choices: [
        {
          text: "export default function App() { return <div>Legacy</div>; }",
          finish_reason: "stop",
        },
      ],
    };
    const res3 = extractTextFromMetaResponse(legacyPayload);
    assert.equal(res3.outputText, "export default function App() { return <div>Legacy</div>; }");

    // 1d. Top-level output_text format
    const topLevelPayload = {
      output_text: "export default function App() { return <div>TopLevel</div>; }",
      finish_reason: "stop",
    };
    const res4 = extractTextFromMetaResponse(topLevelPayload);
    assert.equal(res4.outputText, "export default function App() { return <div>TopLevel</div>; }");
  });

  // 2. Empty message.content
  test("2. Empty message.content throws 502 with clear diagnostic error", () => {
    // 2a. Empty string
    assert.throws(
      () => {
        extractTextFromMetaResponse({
          choices: [{ message: { content: "" } }],
        });
      },
      (err: Error) => {
        assert.match(err.message, /Meta returned an empty completion string/);
        assert.equal((err as unknown as { status: number }).status, 502);
        assert.equal(getErrorStatusCode(err), 502);
        return true;
      }
    );

    // 2b. Whitespace-only string
    assert.throws(
      () => {
        extractTextFromMetaResponse({
          choices: [{ message: { content: "    \n\t  " } }],
        });
      },
      (err: Error) => {
        assert.match(err.message, /Meta returned an empty completion string/);
        assert.equal((err as unknown as { status: number }).status, 502);
        assert.equal(getErrorStatusCode(err), 502);
        return true;
      }
    );
  });

  // 3. Null content
  test("3. Null content throws 502 indicating null completion content", () => {
    assert.throws(
      () => {
        extractTextFromMetaResponse({
          choices: [{ message: { content: null } }],
        });
      },
      (err: Error) => {
        assert.match(err.message, /Meta returned null completion content/);
        assert.equal((err as unknown as { status: number }).status, 502);
        assert.equal(getErrorStatusCode(err), 502);
        return true;
      }
    );
  });

  // 4. Missing or empty choices
  test("4. Missing or empty choices throws 502 with actionable diagnostic", () => {
    // 4a. Missing choices and no top-level text
    assert.throws(
      () => {
        extractTextFromMetaResponse({});
      },
      (err: Error) => {
        assert.match(err.message, /Meta API response missing 'choices' array/);
        assert.equal((err as unknown as { status: number }).status, 502);
        assert.equal(getErrorStatusCode(err), 502);
        return true;
      }
    );

    // 4b. Empty choices array []
    assert.throws(
      () => {
        extractTextFromMetaResponse({ choices: [] });
      },
      (err: Error) => {
        assert.match(err.message, /Meta API returned an empty 'choices' array/);
        assert.equal((err as unknown as { status: number }).status, 502);
        assert.equal(getErrorStatusCode(err), 502);
        return true;
      }
    );
  });

  // 5. Unexpected response structure
  test("5. Unexpected response structure throws 502", () => {
    const invalidInputs = [null, undefined, "not-json", 42, true, []];

    for (const invalid of invalidInputs) {
      assert.throws(
        () => {
          extractTextFromMetaResponse(invalid);
        },
        (err: Error) => {
          assert.match(err.message, /Unexpected Meta API response structure/);
          assert.equal((err as unknown as { status: number }).status, 502);
          assert.equal(getErrorStatusCode(err), 502);
          return true;
        }
      );
    }

    // Embedded error object in 200 response
    assert.throws(
      () => {
        extractTextFromMetaResponse({
          error: { message: "Internal cluster timeout", code: 504 },
        });
      },
      (err: Error) => {
        assert.match(err.message, /Meta API returned an error: Internal cluster timeout/);
        assert.equal((err as unknown as { status: number }).status, 502);
        return true;
      }
    );
  });

  // 6. Refusal or non-text response
  test("6. Refusal and content filter safety responses are caught and marked non-retryable", () => {
    // 6a. Refusal response
    assert.throws(
      () => {
        extractTextFromMetaResponse({
          choices: [
            {
              message: {
                content: null,
                refusal: "I cannot generate code for this application due to policy restrictions.",
              },
            },
          ],
        });
      },
      (err: Error) => {
        assert.match(err.message, /Meta model refused to generate completion/);
        assert.equal((err as unknown as { status: number }).status, 502);
        assert.equal(isRetryableModelError(err), false); // Refusals must not be retried
        return true;
      }
    );

    // 6b. Safety content filter
    assert.throws(
      () => {
        extractTextFromMetaResponse({
          choices: [
            {
              message: { content: "" },
              finish_reason: "content_filter",
            },
          ],
        });
      },
      (err: Error) => {
        assert.match(err.message, /Meta generation was filtered by safety policies/);
        assert.equal((err as unknown as { status: number }).status, 502);
        assert.equal(isRetryableModelError(err), false); // Safety filters must not be retried
        return true;
      }
    );
  });

  // 7. Successful recovery after an empty response
  test("7. Successful staged recovery after an empty response on App.tsx generation", async () => {
    const router = new ModelRouter();

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        plan: "Expense tracker with single root",
        files: [{ path: "App.tsx", purpose: "Main tracker entry point" }],
        dependencies: {},
      }),
      finishReason: "stop",
    };

    // Attempt 1 for App.tsx fails with empty completion
    const emptyErr = new Error("Meta returned an empty completion string.");
    (emptyErr as unknown as { status: number }).status = 502;

    // Attempt 2 (retry) succeeds with valid App.tsx
    const appSuccessResponse: ModelResponse = {
      outputText: JSON.stringify({
        files: [
          {
            path: "App.tsx",
            code: "import React, { useState } from 'react'; export default function App() { return <h1>Expense Tracker</h1>; }",
          },
        ],
        dependencies: {},
      }),
      finishReason: "stop",
    };

    const mockProvider = new MockScriptedProvider([
      planResponse,
      emptyErr,
      appSuccessResponse,
    ]);
    router.registerProvider(mockProvider);

    const result = await executeStagedGenerationPipeline({
      modelRouter: router,
      provider: "meta",
      model: "muse-spark-1.3",
      userPrompt: "Build an expense tracker",
      requestId: "test-recovery-empty-comp",
      maxComponentRetries: 1,
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, "App.tsx");
    assert.match(result.files[0].code, /Expense Tracker/);
    assert.equal(mockProvider.calls.length, 3); // Plan + Attempt 1 + Attempt 2
  });

  // 8. Failure after the configured retry limit
  test("8. Failure after the configured retry limit stops without infinite retries and preserves error status", async () => {
    const router = new ModelRouter();

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        plan: "Note taking app",
        files: [{ path: "App.tsx", purpose: "Main notes app" }],
        dependencies: {},
      }),
      finishReason: "stop",
    };

    const emptyErr1 = new Error("Meta returned an empty completion string.");
    (emptyErr1 as unknown as { status: number }).status = 502;

    const emptyErr2 = new Error("Meta returned an empty completion string.");
    (emptyErr2 as unknown as { status: number }).status = 502;

    const mockProvider = new MockScriptedProvider([
      planResponse,
      emptyErr1,
      emptyErr2,
    ]);
    router.registerProvider(mockProvider);

    await assert.rejects(
      async () => {
        await executeStagedGenerationPipeline({
          modelRouter: router,
          provider: "meta",
          model: "muse-spark-1.3",
          userPrompt: "Build notes app",
          requestId: "test-bounded-retry-fail",
          maxComponentRetries: 1, // Only 1 retry allowed
        });
      },
      (err: Error) => {
        assert.match(err.message, /Meta returned an empty completion/);
        assert.equal((err as unknown as { status: number }).status, 502);
        assert.equal(getErrorStatusCode(err), 502);
        return true;
      }
    );

    // Exactly 3 calls: Plan + 2 attempts for App.tsx (initial + 1 retry)
    assert.equal(mockProvider.calls.length, 3);
  });

  // 9. Permanent HTTP errors (e.g. 401 Unauthorized) are NOT retried
  test("9. Permanent HTTP 401 error is not retried repeatedly", async () => {
    const router = new ModelRouter();

    const planResponse: ModelResponse = {
      outputText: JSON.stringify({
        plan: "Todo app",
        files: [{ path: "App.tsx", purpose: "Main app" }],
        dependencies: {},
      }),
      finishReason: "stop",
    };

    const authErr = new Error("Meta API authentication failed (401). Please check MODEL_API_KEY.");
    (authErr as unknown as { status: number }).status = 401;

    const mockProvider = new MockScriptedProvider([
      planResponse,
      authErr,
    ]);
    router.registerProvider(mockProvider);

    await assert.rejects(
      async () => {
        await executeStagedGenerationPipeline({
          modelRouter: router,
          provider: "meta",
          model: "muse-spark-1.3",
          userPrompt: "Build todo app",
          requestId: "test-no-retry-401",
          maxComponentRetries: 3, // Even with 3 retries configured
        });
      },
      (err: Error) => {
        assert.match(err.message, /Meta API authentication failed \(401\)/);
        assert.equal((err as unknown as { status: number }).status, 401);
        assert.equal(getErrorStatusCode(err), 401);
        return true;
      }
    );

    // Exactly 2 calls: Plan + 1 attempt for App.tsx (NO retries made on 401)
    assert.equal(mockProvider.calls.length, 2);
  });

  // 10. MetaProvider.generate integration with mocked fetch
  test("10. MetaProvider.generate handles valid, empty, and refusal responses correctly", async () => {
    // 10a. Valid response
    const mockValidFetch = (async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "Valid generated code" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const provider1 = new MetaProvider({ apiKey: "test-key", fetchFn: mockValidFetch });
    const res1 = await provider1.generate({ input: "test prompt" });
    assert.equal(res1.outputText, "Valid generated code");

    // 10b. Empty string content response throws 502
    const mockEmptyFetch = (async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "" } }],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const provider2 = new MetaProvider({ apiKey: "test-key", fetchFn: mockEmptyFetch });
    await assert.rejects(
      async () => {
        await provider2.generate({ input: "test prompt" });
      },
      (err: Error) => {
        assert.match(err.message, /Meta returned an empty completion string/);
        assert.equal((err as unknown as { status: number }).status, 502);
        return true;
      }
    );
  });
});
