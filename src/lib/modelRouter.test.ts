import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ModelRouter,
  ModelProvider,
  ModelProviderType,
  ModelRequest,
  ModelResponse,
  isRetryableModelError,
  getFallbackChain,
  MODEL_CAPABILITIES,
  AVAILABLE_PROVIDERS,
  MetaProvider,
  sanitizeErrorMessage,
  getErrorStatusCode,
} from "./modelRouter";

class MockProvider implements ModelProvider {
  name: ModelProviderType = "meta";
  public callHistory: string[] = [];
  public mockBehaviors: Map<string, () => Promise<ModelResponse>> = new Map();

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const model = request.model || "muse-spark-1.3";
    this.callHistory.push(model);

    const behavior = this.mockBehaviors.get(model);
    if (behavior) {
      return behavior();
    }

    return { outputText: `Success from ${model}` };
  }
}

describe("Meta Provider: Model Capabilities & Configuration", () => {
  test("defines single meta provider with muse-spark-1.3 model", () => {
    assert.equal(AVAILABLE_PROVIDERS.length, 1);
    assert.equal(AVAILABLE_PROVIDERS[0].provider, "meta");
    assert.equal(AVAILABLE_PROVIDERS[0].displayName, "Meta");
    assert.equal(AVAILABLE_PROVIDERS[0].models.length, 1);
    assert.equal(AVAILABLE_PROVIDERS[0].models[0].id, "muse-spark-1.3");
    assert.equal(AVAILABLE_PROVIDERS[0].models[0].name, "muse-spark-1.3");
    assert.equal(AVAILABLE_PROVIDERS[0].models[0].isDefault, true);
  });

  test("defines capabilities for muse-spark-1.3", () => {
    assert.equal(Object.keys(MODEL_CAPABILITIES).length, 1);
    assert.equal(MODEL_CAPABILITIES["muse-spark-1.3"].provider, "meta");
    assert.equal(MODEL_CAPABILITIES["muse-spark-1.3"].displayName, "muse-spark-1.3");
    assert.equal(MODEL_CAPABILITIES["muse-spark-1.3"].category, "general-fast");
  });

  test("fallback chain is empty (no cross-provider fallbacks)", () => {
    const chain = getFallbackChain("muse-spark-1.3");
    assert.deepEqual(chain, []);
  });
});

describe("isRetryableModelError", () => {
  test("identifies temporary and retryable errors", () => {
    assert.equal(isRetryableModelError(new Error("Meta API rate limit exceeded (429).")), true);
    assert.equal(isRetryableModelError(new Error("503 Service Unavailable")), true);
    assert.equal(isRetryableModelError(new Error("High demand try again later")), true);
    assert.equal(isRetryableModelError(new Error("Fetch failed timeout")), true);
  });

  test("identifies permanent and non-retryable errors", () => {
    assert.equal(isRetryableModelError(new Error("MODEL_API_KEY is not configured.")), false);
    assert.equal(isRetryableModelError(new Error("Meta API authentication failed (401).")), false);
    assert.equal(isRetryableModelError(new Error("Selected model 'invalid' is not valid")), false);
  });
});

describe("MetaProvider: Meta AI Endpoint & Payload Construction", () => {
  test("endpoint and base URL are constructed correctly", () => {
    const defaultMeta = new MetaProvider({ apiKey: "test-meta-key" });
    const resolved = defaultMeta.getResolvedEndpoint();
    assert.equal(resolved.endpoint, "https://api.meta.ai/v1/chat/completions");
    assert.equal(resolved.baseUrl, "https://api.meta.ai/v1");
    assert.equal(resolved.apiKey, "test-meta-key");

    const custom = new MetaProvider({
      apiKey: "custom-key",
      baseUrl: "https://custom.api.meta.ai/v1/",
    });
    const resolvedCustom = custom.getResolvedEndpoint();
    assert.equal(resolvedCustom.endpoint, "https://custom.api.meta.ai/v1/chat/completions");
    assert.equal(resolvedCustom.baseUrl, "https://custom.api.meta.ai/v1");
  });

  test("Missing MODEL_API_KEY throws clear configuration error", async () => {
    const originalKey = process.env.MODEL_API_KEY;
    delete process.env.MODEL_API_KEY;

    try {
      const provider = new MetaProvider();
      await assert.rejects(
        async () => {
          await provider.generate({ input: "test" });
        },
        (err: Error) => {
          assert.equal(err.message, "MODEL_API_KEY is not configured.");
          return true;
        }
      );
    } finally {
      if (originalKey !== undefined) process.env.MODEL_API_KEY = originalKey;
    }
  });

  test("Authorization uses MODEL_API_KEY and sends request to Meta endpoint", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      capturedBody = JSON.parse((init?.body as string) || "{}");

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  files: [{ path: "App.tsx", code: "export default () => <div>Meta App</div>;" }],
                  dependencies: {},
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const provider = new MetaProvider({
      apiKey: "meta-test-secret-key-12345",
      fetchFn: mockFetch,
    });

    const result = await provider.generate({
      input: "Build a todo app",
      model: "muse-spark-1.3",
      generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
      responseFormat: { type: "text", mime_type: "application/json" },
    });

    assert.equal(capturedUrl, "https://api.meta.ai/v1/chat/completions");
    assert.equal(capturedHeaders["Authorization"], "Bearer meta-test-secret-key-12345");
    assert.equal(capturedHeaders["Content-Type"], "application/json");
    assert.equal(capturedBody.model, "muse-spark-1.3");
    assert.equal(capturedBody.temperature, 0.3);
    assert.equal(capturedBody.max_tokens, 4096);
    assert.deepEqual(capturedBody.response_format, { type: "json_object" });
    assert.match(result.outputText, /Meta App/);
  });

  test("Handles 401 authentication error cleanly with 401 status", async () => {
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
        statusText: "Unauthorized",
      });
    }) as unknown as typeof fetch;

    const provider = new MetaProvider({
      apiKey: "invalid-key",
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await provider.generate({ input: "test" });
      },
      (err: Error) => {
        assert.match(err.message, /authentication failed \(401\)/i);
        assert.match(err.message, /MODEL_API_KEY/);
        assert.equal((err as unknown as { status: number }).status, 401);
        return true;
      }
    );
  });

  test("Handles 429 rate limit cleanly with 429 status", async () => {
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ error: { message: "Too many requests" } }), {
        status: 429,
        statusText: "Too Many Requests",
      });
    }) as unknown as typeof fetch;

    const provider = new MetaProvider({
      apiKey: "valid-key",
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await provider.generate({ input: "test" });
      },
      (err: Error) => {
        assert.match(err.message, /rate limit exceeded \(429\)/i);
        assert.equal((err as unknown as { status: number }).status, 429);
        return true;
      }
    );
  });

  test("Handles network failure cleanly with 503 status", async () => {
    const mockFetch = (async () => {
      throw new Error("connect ECONNREFUSED api.meta.ai");
    }) as unknown as typeof fetch;

    const provider = new MetaProvider({
      apiKey: "valid-key",
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await provider.generate({ input: "test" });
      },
      (err: Error) => {
        assert.match(err.message, /Meta API network request failed/);
        assert.equal((err as unknown as { status: number }).status, 503);
        return true;
      }
    );
  });

  test("Handles malformed JSON from API cleanly with 502 status", async () => {
    const mockFetch = (async () => {
      return new Response("Not JSON body at all", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const provider = new MetaProvider({
      apiKey: "valid-key",
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await provider.generate({ input: "test" });
      },
      (err: Error) => {
        assert.match(err.message, /Failed to parse JSON response from Meta API/);
        assert.equal((err as unknown as { status: number }).status, 502);
        return true;
      }
    );
  });

  test("Handles empty completion output cleanly with 502 status", async () => {
    const mockFetch = (async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "   " } }],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const provider = new MetaProvider({
      apiKey: "valid-key",
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await provider.generate({ input: "test" });
      },
      (err: Error) => {
        assert.match(err.message, /Meta returned an empty completion/);
        assert.equal((err as unknown as { status: number }).status, 502);
        return true;
      }
    );
  });
});

describe("ModelRouter: Meta Provider Routing", () => {
  test("generates successfully with default meta provider and model", async () => {
    const router = new ModelRouter();
    const mock = new MockProvider();
    router.registerProvider(mock);

    const result = await router.generate({ input: "hello" });
    assert.equal(result.outputText, "Success from muse-spark-1.3");
    assert.equal(mock.callHistory.length, 1);
  });

  test("generateWithFallback executes Meta without secondary fallback", async () => {
    const router = new ModelRouter();
    const mock = new MockProvider();
    router.registerProvider(mock);

    const result = await router.generateWithFallback({ input: "build an app" }, "meta");

    assert.equal(result.fallbackUsed, false);
    assert.equal(result.usedModel, "muse-spark-1.3");
    assert.equal(result.usedProvider, "meta");
    assert.equal(result.primaryProvider, "meta");
    assert.equal(result.primaryModel, "muse-spark-1.3");
    assert.equal(result.response.outputText, "Success from muse-spark-1.3");
    assert.equal(mock.callHistory.length, 1);
  });

  test("rejects invalid model name with 400 validation error", async () => {
    const router = new ModelRouter();
    await assert.rejects(
      async () => {
        await router.generateWithFallback(
          { input: "test", model: "non-existent-model" },
          "meta"
        );
      },
      (err: Error) => {
        assert.match(err.message, /is not valid or available/);
        return true;
      }
    );
  });
});

describe("Security & Secret Sanitization", () => {
  test("redacts Meta API keys, Bearer tokens, and legacy tokens from error messages", () => {
    const msg = "Error occurred with key meta-abc12345xyz and Bearer my-secret-token-value";
    const sanitized = sanitizeErrorMessage(msg);
    assert.equal(sanitized.includes("meta-abc12345xyz"), false);
    assert.equal(sanitized.includes("my-secret-token-value"), false);
    assert.match(sanitized, /\[REDACTED\]/);
  });

  test("redacts exact MODEL_API_KEY value even when not prefixed with meta- or Bearer", () => {
    const originalKey = process.env.MODEL_API_KEY;
    const fakeSecret = "secret-token-random-98765-custom";
    process.env.MODEL_API_KEY = fakeSecret;

    try {
      const msg = `Connection dropped while authenticating with token=${fakeSecret} at remote endpoint`;
      const sanitized = sanitizeErrorMessage(msg);
      assert.equal(sanitized.includes(fakeSecret), false);
      assert.match(sanitized, /\[REDACTED\]/);
      assert.equal(
        sanitized,
        "Connection dropped while authenticating with token=[REDACTED] at remote endpoint"
      );
    } finally {
      if (originalKey !== undefined) {
        process.env.MODEL_API_KEY = originalKey;
      } else {
        delete process.env.MODEL_API_KEY;
      }
    }
  });

  test("getErrorStatusCode maps configuration and auth errors properly", () => {
    assert.equal(getErrorStatusCode(new Error("MODEL_API_KEY is not configured.")), 500);
    assert.equal(getErrorStatusCode(new Error("Meta API authentication failed (401).")), 401);
    assert.equal(getErrorStatusCode(new Error("Meta API rate limit exceeded (429).")), 429);
    assert.equal(getErrorStatusCode(new Error("Selected model is not valid or available")), 400);
  });
});
