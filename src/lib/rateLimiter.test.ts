import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeIp,
  extractClientIp,
  SlidingWindowRateLimiter,
  ConcurrencyLimiter,
  defaultRateLimiter,
  defaultConcurrencyLimiter,
} from "./rateLimiter";
import { POST as generateRoute } from "../app/api/generate/route";
import { POST as editRoute } from "../app/api/edit/route";
import { handleAgentRequest as agentRoute } from "./agent/agentHandler";
import { ModelRouter, type ModelProvider, type ModelRequest, type ModelResponse } from "./modelRouter";

class TestMockProvider implements ModelProvider {
  name = "meta" as const;
  public callCount = 0;
  public mockError?: Error;
  public delayMs: number = 0;

  async generate(req: ModelRequest): Promise<ModelResponse> {
    void req;
    this.callCount++;
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.mockError) {
      throw this.mockError;
    }
    return {
      outputText: JSON.stringify({
        files: [
          {
            path: "App.tsx",
            code: "export default function App() { return <div>Test App</div>; }",
          },
        ],
        changedFiles: [
          {
            path: "App.tsx",
            code: "export default function App() { return <div>Test App</div>; }",
          },
        ],
        dependencies: {},
      }),
    };
  }
}

describe("Rate Limiter: Client IP Normalization & Extraction", () => {
  test("normalizes standard IPv4, localhost, and ports correctly", () => {
    assert.equal(normalizeIp("192.168.1.1"), "192.168.1.1");
    assert.equal(normalizeIp("192.168.1.1:8080"), "192.168.1.1");
    assert.equal(normalizeIp("127.0.0.1"), "127.0.0.1");
    assert.equal(normalizeIp("::1"), "127.0.0.1");
    assert.equal(normalizeIp("localhost"), "127.0.0.1");
    assert.equal(normalizeIp("::ffff:10.0.0.1"), "10.0.0.1");
    assert.equal(normalizeIp("[2001:db8::1]:8080"), "2001:db8::1");
  });

  test("normalizes invalid or missing IPs to safe fallback", () => {
    assert.equal(normalizeIp(""), "127.0.0.1");
    assert.equal(normalizeIp("invalid-ip-string"), "127.0.0.1");
  });

  test("untrusted mode ignores arbitrary client X-Forwarded-For to prevent spoofing", () => {
    const req = new Request("http://localhost/api/generate", {
      headers: {
        "x-forwarded-for": "203.0.113.195, 70.41.3.18",
        "x-real-ip": "198.51.100.1",
      },
    });

    // In untrusted mode (direct laptop connection), we do not trust client headers
    const ip = extractClientIp(req, { trustProxy: false });
    assert.equal(ip, "127.0.0.1");
  });

  test("trusted proxy mode extracts client IP from X-Real-IP or X-Forwarded-For", () => {
    const reqWithRealIp = new Request("http://localhost/api/generate", {
      headers: {
        "x-real-ip": "203.0.113.50",
      },
    });
    assert.equal(extractClientIp(reqWithRealIp, { trustProxy: true }), "203.0.113.50");

    const reqWithVercel = new Request("http://localhost/api/generate", {
      headers: {
        "x-vercel-forwarded-for": "198.51.100.42, 10.0.0.1",
      },
    });
    assert.equal(extractClientIp(reqWithVercel, { trustProxy: true }), "198.51.100.42");

    const reqWithForwarded = new Request("http://localhost/api/generate", {
      headers: {
        "x-forwarded-for": "192.0.2.1, 10.0.0.2",
      },
    });
    assert.equal(extractClientIp(reqWithForwarded, { trustProxy: true }), "192.0.2.1");
  });
});

describe("Rate Limiter: SlidingWindowRateLimiter Unit Tests", () => {
  test("permits requests within configured limit and rejects next with 429", () => {
    const mockTime = 100_000;
    const limiter = new SlidingWindowRateLimiter(
      {
        generate: { maxRequests: 2, windowMs: 10_000 },
        edit: { maxRequests: 2, windowMs: 10_000 },
        agent: { maxRequests: 2, windowMs: 10_000 },
        maxConcurrentModelCalls: 3,
      },
      () => mockTime
    );

    // 1st request
    const res1 = limiter.check("10.0.0.1", "generate");
    assert.equal(res1.allowed, true);
    assert.equal(res1.remaining, 1);
    assert.equal(res1.retryAfterSeconds, 0);

    // 2nd request
    const res2 = limiter.check("10.0.0.1", "generate");
    assert.equal(res2.allowed, true);
    assert.equal(res2.remaining, 0);

    // 3rd request (exceeds limit)
    const res3 = limiter.check("10.0.0.1", "generate");
    assert.equal(res3.allowed, false);
    assert.equal(res3.remaining, 0);
    assert.equal(res3.retryAfterSeconds, 10);
  });

  test("maintains separate limits for different client keys and routes", () => {
    const mockTime = 50_000;
    const limiter = new SlidingWindowRateLimiter(
      {
        generate: { maxRequests: 1, windowMs: 5_000 },
        edit: { maxRequests: 1, windowMs: 5_000 },
        agent: { maxRequests: 1, windowMs: 5_000 },
        maxConcurrentModelCalls: 3,
      },
      () => mockTime
    );

    // Client A consumes generate
    assert.equal(limiter.check("client-A", "generate").allowed, true);
    assert.equal(limiter.check("client-A", "generate").allowed, false);

    // Client B can still generate
    assert.equal(limiter.check("client-B", "generate").allowed, true);

    // Client A can still call edit (route isolation)
    assert.equal(limiter.check("client-A", "edit").allowed, true);
  });

  test("allows requests once sliding window elapses and supports clock advancement", () => {
    let mockTime = 10_000;
    const limiter = new SlidingWindowRateLimiter(
      {
        generate: { maxRequests: 1, windowMs: 5_000 },
        edit: { maxRequests: 1, windowMs: 5_000 },
        agent: { maxRequests: 1, windowMs: 5_000 },
        maxConcurrentModelCalls: 3,
      },
      () => mockTime
    );

    assert.equal(limiter.check("client-1", "generate").allowed, true);
    assert.equal(limiter.check("client-1", "generate").allowed, false);

    // Advance clock past window
    mockTime += 5_001;
    assert.equal(limiter.check("client-1", "generate").allowed, true);
  });

  test("reset() clears all tracked limits immediately", () => {
    const limiter = new SlidingWindowRateLimiter({
      generate: { maxRequests: 1, windowMs: 60_000 },
      edit: { maxRequests: 1, windowMs: 60_000 },
      agent: { maxRequests: 1, windowMs: 60_000 },
      maxConcurrentModelCalls: 3,
    });

    assert.equal(limiter.check("client-1", "generate").allowed, true);
    assert.equal(limiter.check("client-1", "generate").allowed, false);

    limiter.reset();
    assert.equal(limiter.check("client-1", "generate").allowed, true);
  });
});

describe("ConcurrencyLimiter: Upstream Model Concurrency Protection", () => {
  test("enforces concurrency bounds and rejects when capacity is exhausted", async () => {
    const limiter = new ConcurrencyLimiter(2);

    let resolveTask1: () => void;
    const task1Promise = new Promise<void>((r) => {
      resolveTask1 = r;
    });

    let resolveTask2: () => void;
    const task2Promise = new Promise<void>((r) => {
      resolveTask2 = r;
    });

    // Start 2 concurrent operations
    const p1 = limiter.execute(async () => {
      await task1Promise;
      return "task1";
    });
    const p2 = limiter.execute(async () => {
      await task2Promise;
      return "task2";
    });

    assert.equal(limiter.active, 2);

    // 3rd concurrent operation must be rejected
    await assert.rejects(
      async () => {
        await limiter.execute(async () => "task3");
      },
      (err: Error) => {
        assert.match(err.message, /Too many concurrent model requests/);
        assert.equal((err as unknown as { status: number }).status, 429);
        assert.equal((err as unknown as { retryAfter: number }).retryAfter, 2);
        return true;
      }
    );

    // Finish task 1
    resolveTask1!();
    assert.equal(await p1, "task1");
    assert.equal(limiter.active, 1);

    // Now a 4th operation can succeed
    const res4 = await limiter.execute(async () => "task4");
    assert.equal(res4, "task4");

    // Finish task 2
    resolveTask2!();
    assert.equal(await p2, "task2");
    assert.equal(limiter.active, 0);
  });

  test("releases concurrency permit in finally even when task throws error", async () => {
    const limiter = new ConcurrencyLimiter(1);

    await assert.rejects(
      async () => {
        await limiter.execute(async () => {
          throw new Error("Upstream network breakdown");
        });
      },
      /Upstream network breakdown/
    );

    // Permit must be released back to 0
    assert.equal(limiter.active, 0);

    // Next request must be able to acquire permit
    const success = await limiter.execute(async () => "recovered");
    assert.equal(success, "recovered");
    assert.equal(limiter.active, 0);
  });
});

describe("Route Integration: Rate Limiting & Concurrency Bounds", () => {
  beforeEach(() => {
    defaultRateLimiter.reset();
    defaultConcurrencyLimiter.reset();
  });

  test("POST /api/generate enforces rate limit and returns HTTP 429 with Retry-After", async () => {
    const mockTime = 1_000;
    const testLimiter = new SlidingWindowRateLimiter(
      {
        generate: { maxRequests: 1, windowMs: 10_000 },
        edit: { maxRequests: 5, windowMs: 10_000 },
        agent: { maxRequests: 5, windowMs: 10_000 },
        maxConcurrentModelCalls: 3,
      },
      () => mockTime
    );

    const makeRequest = () =>
      new Request("http://localhost/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "A calculator app" }),
      });

    // 1st request succeeds or gets past rate limiter
    const res1 = await generateRoute(makeRequest(), { rateLimiter: testLimiter });
    // May succeed or fail on missing MODEL_API_KEY if not mocked, but NOT 429 rate limit
    assert.notEqual(res1.status, 429);

    // 2nd request must be rejected with 429 rate limit
    const res2 = await generateRoute(makeRequest(), { rateLimiter: testLimiter });
    assert.equal(res2.status, 429);
    assert.equal(res2.headers.get("Retry-After"), "10");
    const body2 = await res2.json();
    assert.equal(body2.success, false);
    assert.match(body2.message, /Rate limit exceeded/);
  });

  test("POST /api/edit enforces rate limit and returns HTTP 429 with Retry-After", async () => {
    const mockTime = 2_000;
    const testLimiter = new SlidingWindowRateLimiter(
      {
        generate: { maxRequests: 5, windowMs: 10_000 },
        edit: { maxRequests: 1, windowMs: 10_000 },
        agent: { maxRequests: 5, windowMs: 10_000 },
        maxConcurrentModelCalls: 3,
      },
      () => mockTime
    );

    const makeRequest = () =>
      new Request("http://localhost/api/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction: "Add a button",
          files: [{ path: "App.tsx", code: "export default function App() { return <div />; }" }],
        }),
      });

    const res1 = await editRoute(makeRequest(), { rateLimiter: testLimiter });
    assert.notEqual(res1.status, 429);

    const res2 = await editRoute(makeRequest(), { rateLimiter: testLimiter });
    assert.equal(res2.status, 429);
    assert.equal(res2.headers.get("Retry-After"), "10");
  });

  test("POST /api/agent enforces rate limit and returns HTTP 429 with Retry-After", async () => {
    const mockTime = 3_000;
    const testLimiter = new SlidingWindowRateLimiter(
      {
        generate: { maxRequests: 5, windowMs: 10_000 },
        edit: { maxRequests: 5, windowMs: 10_000 },
        agent: { maxRequests: 1, windowMs: 10_000 },
        maxConcurrentModelCalls: 3,
      },
      () => mockTime
    );

    const makeRequest = () =>
      new Request("http://localhost/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [{ path: "App.tsx", code: "export default function App() { return <div />; }" }],
        }),
      });

    const res1 = await agentRoute(makeRequest(), { rateLimiter: testLimiter });
    assert.notEqual(res1.status, 429);

    const res2 = await agentRoute(makeRequest(), { rateLimiter: testLimiter });
    assert.equal(res2.status, 429);
    assert.equal(res2.headers.get("Retry-After"), "10");
  });

  test("Agent fast path does not acquire concurrency permit when code is valid", async () => {
    const testConcurrencyLimiter = new ConcurrencyLimiter(1);
    const mockProvider = new TestMockProvider();
    const router = new ModelRouter();
    router.registerProvider(mockProvider);

    const req = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "App.tsx", code: "export default function App() { return <div>Valid</div>; }" }],
      }),
    });

    const res = await agentRoute(req, {
      router,
      concurrencyLimiter: testConcurrencyLimiter,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.repaired, false);
    assert.equal(body.attempts, 0);
    // Provider was never called
    assert.equal(mockProvider.callCount, 0);
    // Concurrency limiter remains at 0
    assert.equal(testConcurrencyLimiter.active, 0);
  });

  test("Preserves upstream Meta 429 response and attaches Retry-After header", async () => {
    const mockProvider = new TestMockProvider();
    const upstream429 = new Error("Meta API rate limit exceeded (429). Please try again later.");
    (upstream429 as unknown as { status: number }).status = 429;
    mockProvider.mockError = upstream429;

    const router = new ModelRouter();
    router.registerProvider(mockProvider);

    const req = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "App.tsx", code: "const broken = ;" }],
      }),
    });

    const res = await agentRoute(req, { router });
    assert.equal(res.status, 429);
    assert.ok(res.headers.get("Retry-After"));
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.message, /rate limit exceeded \(429\)/i);
  });

  test("Rejects with 429 when concurrency capacity is exhausted during model call", async () => {
    const testConcurrencyLimiter = new ConcurrencyLimiter(1);
    // Artificially hold the single permit
    assert.equal(testConcurrencyLimiter.tryAcquire(), true);

    const mockProvider = new TestMockProvider();
    const router = new ModelRouter();
    router.registerProvider(mockProvider);

    const req = new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "App.tsx", code: "const broken = ;" }],
      }),
    });

    const res = await agentRoute(req, {
      router,
      concurrencyLimiter: testConcurrencyLimiter,
    });

    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "2");
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.message, /concurrent model requests/i);

    // Release permit and verify next call can proceed
    testConcurrencyLimiter.release();
    assert.equal(testConcurrencyLimiter.active, 0);
  });
});
