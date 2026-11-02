import { NextResponse } from "next/server";

/**
 * Configuration for rate limiting an individual route.
 */
export interface RouteLimitConfig {
  maxRequests: number;
  windowMs: number;
}

/**
 * Application-wide rate limiting settings.
 */
export interface RateLimiterSettings {
  generate: RouteLimitConfig;
  edit: RouteLimitConfig;
  agent: RouteLimitConfig;
  maxConcurrentModelCalls: number;
}

/**
 * Conservative development default limits.
 *
 * NOTE: These limits are configured conservatively for local laptop testing
 * and initial development iteration. They are EXPLICITLY NOT claimed to be
 * production-safe limits. Production deployments on Vercel or cloud environments
 * should adjust these limits based on traffic patterns and upstream Meta AI quotas.
 */
export const DEFAULT_RATE_LIMIT_SETTINGS: RateLimiterSettings = {
  // POST /api/generate - Full React app generation (expensive model call)
  generate: {
    maxRequests: parseInt(process.env.RATE_LIMIT_GENERATE_MAX || "5", 10),
    windowMs: parseInt(process.env.RATE_LIMIT_GENERATE_WINDOW_MS || "60000", 10), // 5 req / min
  },
  // POST /api/edit - Targeted code edits (expensive model call)
  edit: {
    maxRequests: parseInt(process.env.RATE_LIMIT_EDIT_MAX || "10", 10),
    windowMs: parseInt(process.env.RATE_LIMIT_EDIT_WINDOW_MS || "60000", 10), // 10 req / min
  },
  // POST /api/agent - Syntax repair loop (may execute 0 to 2 model calls)
  agent: {
    maxRequests: parseInt(process.env.RATE_LIMIT_AGENT_MAX || "20", 10),
    windowMs: parseInt(process.env.RATE_LIMIT_AGENT_WINDOW_MS || "60000", 10), // 20 req / min
  },
  // Global maximum concurrent in-flight model calls across all routes
  maxConcurrentModelCalls: parseInt(
    process.env.MAX_CONCURRENT_MODEL_CALLS || "3",
    10
  ),
};

/**
 * Result returned by a rate limiter check.
 */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetTime: number;
}

/**
 * Abstract rate limiter interface allowing pluggable stores
 * (e.g. in-memory sliding window for laptop testing, or Upstash / Vercel KV for production).
 */
export interface IRateLimiter {
  check(
    clientIp: string,
    route: "generate" | "edit" | "agent"
  ): Promise<RateLimitResult> | RateLimitResult;
  reset(): Promise<void> | void;
}

export interface ClientIpOptions {
  /**
   * If true, trusts reverse proxy headers (e.g. Vercel, Cloudflare, Nginx).
   * Default: true if process.env.TRUST_PROXY === "true" or process.env.VERCEL === "1", else false.
   */
  trustProxy?: boolean;
}

/**
 * Normalizes an IP address string by trimming, lowering case,
 * stripping port numbers, normalizing IPv4-mapped IPv6, and standardizing localhost.
 */
export function normalizeIp(rawIp: string): string {
  if (!rawIp || typeof rawIp !== "string") {
    return "127.0.0.1";
  }

  let ip = rawIp.trim();

  // Strip port from IPv4 (e.g., 192.168.1.1:8080)
  if (/^(\d{1,3}\.){3}\d{1,3}:\d+$/.test(ip)) {
    ip = ip.split(":")[0];
  }

  // Strip port from IPv6 (e.g., [2001:db8::1]:8080)
  if (ip.startsWith("[") && ip.includes("]:")) {
    ip = ip.slice(1, ip.indexOf("]:"));
  }

  // IPv4-mapped IPv6 (::ffff:192.0.2.1 -> 192.0.2.1)
  if (ip.toLowerCase().startsWith("::ffff:")) {
    ip = ip.slice(7);
  }

  // Normalize localhost
  if (ip === "::1" || ip === "localhost") {
    return "127.0.0.1";
  }

  // Validate format (IPv4 or IPv6 basic validation)
  const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
  const isIpv6 = /^[0-9a-fA-F:]+$/.test(ip) && ip.includes(":");

  if (!isIpv4 && !isIpv6) {
    return "127.0.0.1";
  }

  return ip.toLowerCase();
}

/**
 * Extracts a normalized client IP from request headers.
 *
 * PROXY & TRUST ASSUMPTIONS:
 * - In local laptop testing (trustProxy = false by default): We do NOT blindly trust
 *   arbitrary X-Forwarded-For headers from untrusted clients, as an attacker can spoof
 *   random IPs to bypass rate limits. Local requests without trusted proxy default to "127.0.0.1".
 * - In Vercel / Cloud deployments (trustProxy = true or process.env.VERCEL === "1"):
 *   Vercel edge proxies append or set trusted headers. We check `x-real-ip`,
 *   `x-vercel-forwarded-for`, and `x-forwarded-for` (leftmost client IP).
 */
export function extractClientIp(
  request: Request,
  options: ClientIpOptions = {}
): string {
  const trustProxy =
    options.trustProxy ??
    (process.env.TRUST_PROXY === "true" || process.env.VERCEL === "1");

  if (!trustProxy) {
    // In local standalone mode without trusted reverse proxy, do not trust client-supplied headers
    return "127.0.0.1";
  }

  // 1. Check x-real-ip
  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    const normalized = normalizeIp(realIp);
    if (normalized !== "127.0.0.1" || realIp.includes("127.0.0.1") || realIp.includes("::1")) {
      return normalized;
    }
  }

  // 2. Check x-vercel-forwarded-for
  const vercelIp = request.headers.get("x-vercel-forwarded-for");
  if (vercelIp) {
    const firstVercel = vercelIp.split(",")[0].trim();
    return normalizeIp(firstVercel);
  }

  // 3. Check x-forwarded-for (take leftmost, representing originating client)
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const firstForwarded = forwardedFor.split(",")[0].trim();
    return normalizeIp(firstForwarded);
  }

  return "127.0.0.1";
}

/**
 * In-memory sliding-window rate limiter.
 *
 * Tracks request timestamps per key in a sliding time window.
 * Supports injected clocks and resets for deterministic testing.
 */
export class SlidingWindowRateLimiter implements IRateLimiter {
  private store: Map<string, number[]> = new Map();
  private settings: RateLimiterSettings;
  private clock: () => number;

  constructor(
    settings: RateLimiterSettings = DEFAULT_RATE_LIMIT_SETTINGS,
    clock: () => number = () => Date.now()
  ) {
    this.settings = settings;
    this.clock = clock;
  }

  public check(
    clientIp: string,
    route: "generate" | "edit" | "agent"
  ): RateLimitResult {
    const config = this.settings[route];
    const now = this.clock();
    const key = `${route}:${clientIp}`;

    const timestamps = this.store.get(key) || [];
    const windowStart = now - config.windowMs;

    // Prune entries outside the current sliding window
    const activeTimestamps = timestamps.filter((t) => t > windowStart);

    if (activeTimestamps.length >= config.maxRequests) {
      const oldest = activeTimestamps[0];
      const resetTime = oldest + config.windowMs;
      const retryAfterMs = Math.max(0, resetTime - now);
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));

      this.store.set(key, activeTimestamps);

      return {
        allowed: false,
        limit: config.maxRequests,
        remaining: 0,
        retryAfterSeconds,
        resetTime,
      };
    }

    activeTimestamps.push(now);
    this.store.set(key, activeTimestamps);

    return {
      allowed: true,
      limit: config.maxRequests,
      remaining: config.maxRequests - activeTimestamps.length,
      retryAfterSeconds: 0,
      resetTime: now + config.windowMs,
    };
  }

  public reset(): void {
    this.store.clear();
  }

  public setClock(clock: () => number): void {
    this.clock = clock;
  }

  public getSettings(): RateLimiterSettings {
    return this.settings;
  }
}

/**
 * Semaphore-based concurrency limiter for upstream model calls.
 * Ensures in-flight concurrent requests cannot grow without bound,
 * and guarantees permits are released in `finally` blocks.
 */
export class ConcurrencyLimiter {
  private maxConcurrent: number;
  private activeCount: number = 0;

  constructor(maxConcurrent: number = 3) {
    this.maxConcurrent = maxConcurrent;
  }

  public get active(): number {
    return this.activeCount;
  }

  public get capacity(): number {
    return this.maxConcurrent;
  }

  public tryAcquire(): boolean {
    if (this.activeCount >= this.maxConcurrent) {
      return false;
    }
    this.activeCount++;
    return true;
  }

  public release(): void {
    if (this.activeCount > 0) {
      this.activeCount--;
    }
  }

  /**
   * Executes a task with a concurrency permit.
   * If concurrency capacity is exhausted, immediately throws an error with status 429
   * and a recommended retry-after delay.
   * Guaranteed to release permit in finally.
   */
  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.tryAcquire()) {
      const error = new Error(
        "Too many concurrent model requests in progress. Please try again shortly."
      );
      (error as unknown as { status: number; statusCode: number; retryAfter: number }).status = 429;
      (error as unknown as { status: number; statusCode: number; retryAfter: number }).statusCode = 429;
      (error as unknown as { status: number; statusCode: number; retryAfter: number }).retryAfter = 2;
      throw error;
    }
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  public reset(): void {
    this.activeCount = 0;
  }
}

// Default global instances
export const defaultRateLimiter = new SlidingWindowRateLimiter();
export const defaultConcurrencyLimiter = new ConcurrencyLimiter(
  DEFAULT_RATE_LIMIT_SETTINGS.maxConcurrentModelCalls
);

/**
 * Enforces rate limiting on an incoming route request.
 * Returns either `{ allowed: true, clientIp }` or an HTTP 429 `NextResponse` with valid `Retry-After` header.
 */
export async function enforceRouteRateLimit(
  request: Request,
  route: "generate" | "edit" | "agent",
  options?: {
    limiter?: IRateLimiter;
    requestId?: string;
    trustProxy?: boolean;
  }
): Promise<{ allowed: true; clientIp: string } | { allowed: false; response: NextResponse }> {
  const clientIp = extractClientIp(request, { trustProxy: options?.trustProxy });
  const limiter = options?.limiter || defaultRateLimiter;
  const result = await limiter.check(clientIp, route);
  const reqId = options?.requestId || Math.random().toString(36).substring(2, 10);

  if (!result.allowed) {
    return {
      allowed: false,
      response: NextResponse.json(
        {
          success: false,
          requestId: reqId,
          message: "Rate limit exceeded. Please wait before making more requests.",
          retryAfter: result.retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(result.retryAfterSeconds),
            "X-RateLimit-Limit": String(result.limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Math.ceil(result.resetTime / 1000)),
          },
        }
      ),
    };
  }

  return { allowed: true, clientIp };
}
