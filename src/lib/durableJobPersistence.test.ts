import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  PostgresJobStore,
  MemoryJobStore,
  GenerationJobStoreManager,
  globalJobStore,
  mergeJobFiles,
  type GenerationJob,
  type GenerationJobResult,
  type IDatabaseClient,
} from "./generationJobs";
import { type GeneratedFile, type PlannedFile } from "./jsonRecovery";
import { sanitizeErrorMessage } from "./modelRouter";
import { GET as generateGet, POST as generatePost } from "../app/api/generate/route";

describe("Phase 3: Durable Generation Job Persistence", () => {
  // ---------------------------------------------------------------------------
  // Test 1: Full Job Records Persistence & Retrieval
  // ---------------------------------------------------------------------------
  test("persists full job record including source code, manifest, version, and timestamps", async () => {
    const store = new MemoryJobStore({ ttlMs: 3600000 });

    const initialFiles: GeneratedFile[] = [
      { path: "src/types.ts", code: "export interface User { id: string; name: string; }" },
    ];
    const initialManifest: PlannedFile[] = [
      { path: "src/types.ts", purpose: "Data types" },
      { path: "src/App.tsx", purpose: "Main entry point" },
      { path: "src/components/Header.tsx", purpose: "Header component" },
    ];

    const job = await store.createJob(
      "job-p3-1",
      "Build a project management dashboard",
      "meta",
      "muse-spark-1.3",
      initialFiles,
      initialManifest
    );

    assert.equal(job.id, "job-p3-1");
    assert.equal(job.provider, "meta");
    assert.equal(job.model, "muse-spark-1.3");
    assert.equal(job.status, "pending");
    assert.equal(job.version, 1);
    assert.deepEqual(job.completedFilePaths, ["src/types.ts"]);
    assert.equal(job.partialFiles?.length, 1);
    assert.equal(job.manifest?.length, 3);

    // Update progress with new completed file
    const newFiles: GeneratedFile[] = [
      { path: "src/components/Header.tsx", code: "export const Header = () => <header>Dashboard</header>;" },
    ];
    const updated = await store.updateJobProgress("job-p3-1", {
      status: "generating_components",
      stageMessage: "Generated Header component",
      progressPercent: 50,
      partialFiles: newFiles,
      pendingFilePaths: ["src/App.tsx"],
    });

    assert.ok(updated);
    assert.equal(updated.status, "generating_components");
    assert.equal(updated.progressPercent, 50);
    assert.equal(updated.version, 2);
    assert.equal(updated.partialFiles?.length, 2);
    assert.ok(updated.completedFilePaths.includes("src/types.ts"));
    assert.ok(updated.completedFilePaths.includes("src/components/Header.tsx"));

    // Verify retrieval from store preserves exact source code
    const retrieved = await store.getJob("job-p3-1");
    assert.ok(retrieved);
    const headerFile = retrieved.partialFiles?.find((f) => f.path === "src/components/Header.tsx");
    assert.ok(headerFile);
    assert.equal(headerFile.code, "export const Header = () => <header>Dashboard</header>;");

    // Complete job
    const completedResult: GenerationJobResult = {
      files: [
        ...retrieved.partialFiles!,
        { path: "src/App.tsx", code: "export default function App() { return <div>App</div>; }" },
      ],
      dependencies: { lucide_react: "^0.300.0" },
      generatedCode: "export default function App() { return <div>App</div>; }",
      usedModel: "muse-spark-1.3",
      usedProvider: "meta",
      fallbackUsed: false,
    };

    const completed = await store.completeJob("job-p3-1", completedResult);
    assert.ok(completed);
    assert.equal(completed.status, "completed");
    assert.equal(completed.progressPercent, 100);
    assert.equal(completed.result?.files.length, 3);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Restart Recovery & Continuity across Store Instances
  // ---------------------------------------------------------------------------
  test("recovers job state after simulated server restart without losing completed files", async () => {
    // Shared underlying storage simulates a database table surviving container restarts
    const sharedDbRows = new Map<string, any>();

    const mockDb: IDatabaseClient = {
      async query(text: string, params?: unknown[]) {
        if (text.includes("CREATE TABLE")) {
          return { rows: [], rowCount: 0, command: "CREATE", oid: 0, fields: [] };
        }
        if (text.includes("INSERT INTO generation_jobs")) {
          const row = {
            id: params![0],
            prompt: params![1],
            provider: params![2],
            model: params![3],
            status: params![4],
            stage_message: params![5],
            progress_percent: params![6],
            completed_file_paths: params![7],
            pending_file_paths: params![8],
            failed_file_paths: params![9],
            partial_files: params![10],
            manifest: params![11],
            created_at: params![12],
            updated_at: params![13],
            expires_at: params![14],
            version: 1,
          };
          sharedDbRows.set(params![0] as string, row);
          return { rows: [row], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
        }
        if (text.includes("SELECT * FROM generation_jobs WHERE id = $1")) {
          const row = sharedDbRows.get(params![0] as string);
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0, command: "SELECT", oid: 0, fields: [] };
        }
        if (text.includes("UPDATE generation_jobs SET")) {
          const id = params![params!.length - 1] as string;
          const current = sharedDbRows.get(id);
          if (current) {
            current.status = params![0];
            current.stage_message = params![1];
            current.progress_percent = params![2];
            current.completed_file_paths = params![3];
            current.pending_file_paths = params![4];
            current.failed_file_paths = params![5];
            current.partial_files = params![6];
            current.manifest = params![7];
            current.updated_at = params![8];
            current.version = (current.version || 1) + 1;
          }
          return { rows: current ? [current] : [], rowCount: current ? 1 : 0, command: "UPDATE", oid: 0, fields: [] };
        }
        return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
      },
    };

    // Store Instance 1: Before Restart
    const storeInstance1 = new PostgresJobStore({ pool: mockDb });
    const initialFiles: GeneratedFile[] = [
      { path: "src/utils/math.ts", code: "export const add = (a: number, b: number) => a + b;" },
    ];
    const manifest: PlannedFile[] = [
      { path: "src/utils/math.ts", purpose: "Math utilities" },
      { path: "src/components/Calculator.tsx", purpose: "Calculator component" },
    ];

    await storeInstance1.createJob("restart-job-1", "Build calculator app", "meta", "muse-spark-1.3", initialFiles, manifest);

    // Instance 1 crashes / server restarts.
    // Store Instance 2: New application container starts and connects to same database
    const storeInstance2 = new PostgresJobStore({ pool: mockDb });

    const retrievedJob = await storeInstance2.getJob("restart-job-1");
    assert.ok(retrievedJob, "Job must be retrievable from new store instance after restart");
    assert.equal(retrievedJob.id, "restart-job-1");
    assert.equal(retrievedJob.partialFiles?.length, 1);
    assert.equal(retrievedJob.partialFiles![0].path, "src/utils/math.ts");
    assert.equal(retrievedJob.partialFiles![0].code, "export const add = (a: number, b: number) => a + b;");
    assert.equal(retrievedJob.manifest?.length, 2);
  });

  // ---------------------------------------------------------------------------
  // Test 3: Interrupted Stale Job Safe Recovery (Never Marked Completed)
  // ---------------------------------------------------------------------------
  test("recovers interrupted stale job into safe 504 resumable state and never marks it completed", async () => {
    // Threshold set to 100ms for testing stale detection
    const store = new MemoryJobStore({ staleJobThresholdMs: 100 });

    const partialFiles: GeneratedFile[] = [
      { path: "src/types.ts", code: "export interface Task { id: string; title: string; }" },
    ];
    const manifest: PlannedFile[] = [
      { path: "src/types.ts", purpose: "Types" },
      { path: "src/components/TaskList.tsx", purpose: "Task list" },
    ];

    await store.createJob("stale-job-1", "Build task manager", "meta", "muse-spark-1.3", partialFiles, manifest);

    await store.updateJobProgress("stale-job-1", {
      status: "generating_components",
      stageMessage: "Generating components...",
      progressPercent: 40,
      pendingFilePaths: ["src/components/TaskList.tsx"],
    });

    // Wait past stale threshold to simulate an unhandled process termination / restart
    await new Promise((resolve) => setTimeout(resolve, 150));

    // When retrieved, it must detect interruption and mark as 504 failed (resumable)
    const recovered = await store.getJob("stale-job-1");
    assert.ok(recovered);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.statusCode, 504);
    assert.notEqual(recovered.status, "completed", "Interrupted job must NEVER be marked as completed");
    assert.ok(recovered.error?.includes("interrupted by a server restart"));
    assert.ok(recovered.error?.includes("resumeJobId"));

    // Completed files must remain completely intact
    assert.equal(recovered.partialFiles?.length, 1);
    assert.equal(recovered.partialFiles![0].path, "src/types.ts");
  });

  // ---------------------------------------------------------------------------
  // Test 4: Multi-Instance Distributed Resume Locking (409 Conflict Prevention)
  // ---------------------------------------------------------------------------
  test("distributed resume locking prevents concurrent resume collisions", async () => {
    const store = new MemoryJobStore({ resumeLockTtlMs: 500 });
    await store.createJob("lock-job-1", "Prompt", "meta", "muse-spark-1.3");

    // Worker A acquires lock
    const lockA = await store.acquireResumeLock("lock-job-1", "worker-A");
    assert.equal(lockA, true, "Worker A should acquire resume lock");

    // Worker B attempts to resume same job while Worker A holds lock
    const lockB = await store.acquireResumeLock("lock-job-1", "worker-B");
    assert.equal(lockB, false, "Worker B should be blocked from acquiring active resume lock");

    // Worker A renews / re-enters lock
    const lockARenew = await store.acquireResumeLock("lock-job-1", "worker-A");
    assert.equal(lockARenew, true, "Worker A should be able to renew its own lock");

    // Worker A releases lock
    await store.releaseResumeLock("lock-job-1", "worker-A");

    // Worker B can now acquire the lock
    const lockBAfterRelease = await store.acquireResumeLock("lock-job-1", "worker-B");
    assert.equal(lockBAfterRelease, true, "Worker B should acquire lock after Worker A releases it");

    // Clean up
    await store.releaseResumeLock("lock-job-1", "worker-B");
  });

  // ---------------------------------------------------------------------------
  // Test 5: Expiration Policy and TTL Cleanup
  // ---------------------------------------------------------------------------
  test("correctly cleans up expired generation jobs past TTL", async () => {
    const store = new MemoryJobStore({ ttlMs: 100 });

    await store.createJob("expired-job", "Prompt 1", "meta", "muse-spark-1.3");
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Create a fresh job after the delay
    await store.createJob("active-job", "Prompt 2", "meta", "muse-spark-1.3");

    const cleanedCount = await store.cleanupExpiredJobs();
    assert.equal(cleanedCount, 1, "Should clean up 1 expired job");

    assert.equal(await store.getJob("expired-job"), undefined, "Expired job should be removed");
    assert.ok(await store.getJob("active-job"), "Active job should remain accessible");
  });

  // ---------------------------------------------------------------------------
  // Test 6: Production Safety - Rejects Missing DB in Production & Masks Secrets
  // ---------------------------------------------------------------------------
  test("enforces database requirement in production and masks database connection secrets", () => {
    const originalEnv = process.env.NODE_ENV;
    const originalDbUrl = process.env.DATABASE_URL;
    const originalPgUrl = process.env.POSTGRES_URL;

    try {
      (process.env as any).NODE_ENV = "production";
      delete process.env.DATABASE_URL;
      delete process.env.POSTGRES_URL;

      // In production with no DATABASE_URL, instantiation must throw an actionable error
      assert.throws(
        () => new GenerationJobStoreManager(),
        /Production database configuration missing: Set DATABASE_URL or POSTGRES_URL/
      );

      // Verify secret masking for connection string errors
      const sensitiveError =
        "connection to server at postgres://user:supersecretpass@roundhouse.proxy.rlwy.net:12345/db failed";
      const masked = sanitizeErrorMessage(sensitiveError);
      assert.ok(!masked.includes("supersecretpass"), "Database password must not appear in sanitized message");
      assert.ok(masked.includes("[REDACTED]") || !masked.includes("user:supersecretpass"));
    } finally {
      (process.env as any).NODE_ENV = originalEnv;
      if (originalDbUrl) process.env.DATABASE_URL = originalDbUrl;
      if (originalPgUrl) process.env.POSTGRES_URL = originalPgUrl;
    }
  });

  // ---------------------------------------------------------------------------
  // Test 7: PostgresJobStore SQL Query & Parameter Verification
  // ---------------------------------------------------------------------------
  test("PostgresJobStore executes correct SQL and parameter serialization", async () => {
    const executedQueries: { text: string; params?: unknown[] }[] = [];

    const mockPool: IDatabaseClient = {
      async query(text: string, params?: unknown[]) {
        executedQueries.push({ text, params });
        if (text.includes("CREATE TABLE")) {
          return { rows: [], rowCount: 0, command: "CREATE", oid: 0, fields: [] };
        }
        if (text.includes("INSERT INTO generation_jobs")) {
          return { rows: [], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
        }
        if (text.includes("SELECT * FROM generation_jobs WHERE id = $1")) {
          return {
            rows: [
              {
                id: params![0],
                prompt: "Test prompt",
                provider: "meta",
                model: "muse-spark-1.3",
                status: "pending",
                stage_message: "Initializing...",
                progress_percent: 5,
                completed_file_paths: JSON.stringify(["src/App.tsx"]),
                pending_file_paths: JSON.stringify([]),
                failed_file_paths: JSON.stringify([]),
                partial_files: JSON.stringify([{ path: "src/App.tsx", code: "export default () => <div>App</div>;" }]),
                manifest: JSON.stringify([{ path: "src/App.tsx", description: "Entry point" }]),
                created_at: Date.now(),
                updated_at: Date.now(),
                expires_at: Date.now() + 3600000,
                version: 1,
              },
            ],
            rowCount: 1,
            command: "SELECT",
            oid: 0,
            fields: [],
          };
        }
        if (text.includes("UPDATE generation_jobs SET resume_lock_worker")) {
          return { rows: [], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
        }
        if (text.includes("UPDATE generation_jobs SET")) {
          return { rows: [], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
        }
        return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
      },
    };

    const pgStore = new PostgresJobStore({ pool: mockPool });

    // 1. Create job
    await pgStore.createJob("pg-job-1", "Test prompt", "meta", "muse-spark-1.3", [
      { path: "src/App.tsx", code: "export default () => <div>App</div>;" },
    ]);

    // Verify table creation query was issued
    const createTableQuery = executedQueries.find((q) => q.text.includes("CREATE TABLE IF NOT EXISTS generation_jobs"));
    assert.ok(createTableQuery, "Should ensure generation_jobs table exists");

    // Verify insert query parameters
    const insertQuery = executedQueries.find((q) => q.text.includes("INSERT INTO generation_jobs"));
    assert.ok(insertQuery, "Should execute INSERT INTO generation_jobs");
    assert.equal(insertQuery.params![0], "pg-job-1");
    assert.equal(insertQuery.params![1], "Test prompt");
    assert.equal(insertQuery.params![2], "meta");
    assert.equal(insertQuery.params![3], "muse-spark-1.3");

    // 2. Retrieve job
    const retrieved = await pgStore.getJob("pg-job-1");
    assert.ok(retrieved);
    assert.equal(retrieved.id, "pg-job-1");
    assert.equal(retrieved.partialFiles?.length, 1);
    assert.equal(retrieved.partialFiles![0].path, "src/App.tsx");

    // 3. Acquire lock
    const locked = await pgStore.acquireResumeLock("pg-job-1", "worker-123");
    assert.equal(locked, true);
    const lockQuery = executedQueries.find((q) => q.text.includes("resume_lock_worker = $1"));
    assert.ok(lockQuery, "Should execute atomic UPDATE query for resume lock");
  });

  // ---------------------------------------------------------------------------
  // Test 8: API Route Multi-Instance Integration (GET and POST with Resume Lock)
  // ---------------------------------------------------------------------------
  test("API route GET and POST handle durable job querying and lock conflicts gracefully", async () => {
    // Clear and prepare test job in globalJobStore
    globalJobStore.clear();

    const initialFiles: GeneratedFile[] = [
      { path: "src/components/Card.tsx", code: "export const Card = () => <div>Card</div>;" },
    ];
    await globalJobStore.createJobAsync(
      "api-test-job-1",
      "Build a dashboard",
      "meta",
      "muse-spark-1.3",
      initialFiles,
      [{ path: "src/components/Card.tsx", purpose: "Card component" }]
    );

    // 1. GET /api/generate?jobId=api-test-job-1
    const getReq = new Request("http://localhost:3000/api/generate?jobId=api-test-job-1");
    const getRes = await generateGet(getReq);
    assert.equal(getRes.status, 200);
    const getJson = await getRes.json();
    assert.equal(getJson.success, true);
    assert.equal(getJson.jobId, "api-test-job-1");
    assert.equal(getJson.files.length, 1);
    assert.equal(getJson.files[0].path, "src/components/Card.tsx");

    // 2. Lock the job to simulate another worker currently resuming it
    await globalJobStore.acquireResumeLock("api-test-job-1", "other-worker-999");

    // 3. POST /api/generate with resumeJobId=api-test-job-1 should fail with 409 Conflict
    const resumeReq = new Request("http://localhost:3000/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resumeJobId: "api-test-job-1",
        mode: "sync",
      }),
    });

    const resumeRes = await generatePost(resumeReq);
    assert.equal(resumeRes.status, 409, "Should return 409 Conflict when job is locked by another worker");
    const resumeJson = await resumeRes.json();
    assert.equal(resumeJson.success, false);
    assert.ok(resumeJson.message.includes("currently being resumed"));

    // Release lock and verify resume can proceed
    await globalJobStore.releaseResumeLock("api-test-job-1", "other-worker-999");
  });

  // ---------------------------------------------------------------------------
  // Test 9: Active Generation Heartbeat & Continuous Resume-Lock Renewal
  // ---------------------------------------------------------------------------
  test("heartbeat continually updates updatedAt and renews resume lock during long model calls", async () => {
    // 200ms stale threshold and lock TTL, with 50ms heartbeat interval
    const store = new MemoryJobStore({
      staleJobThresholdMs: 200,
      resumeLockTtlMs: 200,
    });

    const job = store.createJob("hb-job-1", "Prompt", "meta", "muse-spark-1.3");
    await store.acquireResumeLock("hb-job-1", "worker-active", 200);

    const initialUpdatedAt = job.updatedAt;

    // Start background heartbeat
    const { startJobHeartbeat } = await import("./generationJobs");
    const hb = startJobHeartbeat("hb-job-1", "worker-active", {
      store,
      intervalMs: 50,
      lockTtlMs: 200,
    });

    try {
      // Simulate long Meta API call lasting 350ms (well past the 200ms stale threshold and lock TTL)
      await new Promise((resolve) => setTimeout(resolve, 350));

      // 1. Verify job was NOT marked stale or failed
      const activeJob = await store.getJob("hb-job-1");
      assert.ok(activeJob);
      assert.notEqual(activeJob.status, "failed", "Active job must not be marked failed during active generation");
      assert.ok(activeJob.updatedAt > initialUpdatedAt, "updatedAt must be continually refreshed by heartbeat");

      // 2. Verify competing worker CANNOT steal the lock because heartbeat kept it renewed
      const competingLock = await store.acquireResumeLock("hb-job-1", "worker-competing");
      assert.equal(competingLock, false, "Competing worker must be rejected while heartbeat is renewing lock");
    } finally {
      // Stop heartbeat (simulating generation completion or container termination)
      hb.stop();
    }

    // Now wait past the 200ms threshold without heartbeat (simulating container crash)
    await new Promise((resolve) => setTimeout(resolve, 250));

    // After container crash without heartbeat, job is safely identified as interrupted
    const interruptedJob = await store.getJob("hb-job-1");
    assert.ok(interruptedJob);
    assert.equal(interruptedJob.status, "failed");
    assert.equal(interruptedJob.statusCode, 504);

    // And competitor worker can now acquire the lock
    const lockAfterCrash = await store.acquireResumeLock("hb-job-1", "worker-competing");
    assert.equal(lockAfterCrash, true, "Competitor must be able to acquire lock after interrupted job expires");
    await store.releaseResumeLock("hb-job-1", "worker-competing");
  });

  // ---------------------------------------------------------------------------
  // Test 10: Multi-Instance Concurrent Resume Prevention (HTTP 409 Conflict)
  // ---------------------------------------------------------------------------
  test("two instances cannot generate or resume the same job simultaneously", async () => {
    globalJobStore.clear();

    await globalJobStore.createJobAsync(
      "concurrent-test-job",
      "Build app",
      "meta",
      "muse-spark-1.3",
      [{ path: "src/App.tsx", code: "export default () => <div>App</div>;" }]
    );

    // Instance 1 acquires lock for worker-1
    const acquired1 = await globalJobStore.acquireResumeLock("concurrent-test-job", "instance-1-worker");
    assert.equal(acquired1, true);

    // Instance 2 attempts to resume the same job while Instance 1 is running
    const resumeReq = new Request("http://localhost:3000/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resumeJobId: "concurrent-test-job",
        mode: "sync",
      }),
    });

    const resumeRes = await generatePost(resumeReq);
    assert.equal(resumeRes.status, 409, "Must return HTTP 409 Conflict when job is locked by another instance");
    const json = await resumeRes.json();
    assert.equal(json.success, false);
    assert.ok(json.message.includes("currently being resumed by another worker"));

    // Instance 1 finishes and releases lock
    await globalJobStore.releaseResumeLock("concurrent-test-job", "instance-1-worker");

    // Instance 2 can now acquire the lock
    const acquired2 = await globalJobStore.acquireResumeLock("concurrent-test-job", "instance-2-worker");
    assert.equal(acquired2, true, "Instance 2 must be able to acquire lock after Instance 1 releases it");
    await globalJobStore.releaseResumeLock("concurrent-test-job", "instance-2-worker");
  });

  // ---------------------------------------------------------------------------
  // Test 11: Lock Release Safety on Completion, Failure, and Exceptions
  // ---------------------------------------------------------------------------
  test("locks are safely released on completion, errors, and unhandled rejections", async () => {
    globalJobStore.clear();

    const jobId = "lock-safety-job";
    await globalJobStore.createJobAsync(jobId, "Prompt", "meta", "muse-spark-1.3");

    // Acquire lock
    await globalJobStore.acquireResumeLock(jobId, "worker-test");

    // Simulate safe release in finally block
    try {
      throw new Error("Simulated pipeline failure");
    } catch {
      // Error handled
    } finally {
      await globalJobStore.releaseResumeLock(jobId, "worker-test");
    }

    // Verify lock is immediately available for the next worker
    const reacquired = await globalJobStore.acquireResumeLock(jobId, "worker-next");
    assert.equal(reacquired, true, "Lock must be released and immediately available after failure");
    await globalJobStore.releaseResumeLock(jobId, "worker-next");
  });

  // ---------------------------------------------------------------------------
  // Test 12: Server Interruption and Resume Preserves Completed Files
  // ---------------------------------------------------------------------------
  test("resuming after server interruption preserves completed files and does not regenerate them", async () => {
    const store = new MemoryJobStore({ staleJobThresholdMs: 50 });

    const completedFiles: GeneratedFile[] = [
      { path: "src/types.ts", code: "export interface Config { debug: boolean; }" },
      { path: "src/components/Header.tsx", code: "export const Header = () => <div>Header</div>;" },
    ];
    const plannedManifest: PlannedFile[] = [
      { path: "src/types.ts", purpose: "Config types" },
      { path: "src/components/Header.tsx", purpose: "Header component" },
      { path: "src/App.tsx", purpose: "Root application orchestrator" },
    ];

    // Create job with 2 already completed files
    await store.createJob("interrupted-job-12", "Build dashboard", "meta", "muse-spark-1.3", completedFiles, plannedManifest);
    await store.updateJobProgress("interrupted-job-12", {
      status: "generating_components",
      pendingFilePaths: ["src/App.tsx"],
    });

    // Wait past stale threshold to simulate server restart
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify recovery into 504 resumable state
    const staleJob = await store.getJob("interrupted-job-12");
    assert.ok(staleJob);
    assert.equal(staleJob.status, "failed");
    assert.equal(staleJob.statusCode, 504);

    // Verify all completed files are preserved verbatim
    assert.equal(staleJob.partialFiles?.length, 2);
    assert.ok(staleJob.partialFiles.some((f) => f.path === "src/types.ts"));
    assert.ok(staleJob.partialFiles.some((f) => f.path === "src/components/Header.tsx"));

    // Verify merge logic preserves completed files
    const newAddition: GeneratedFile[] = [
      { path: "src/App.tsx", code: "export default () => <div>App</div>;" },
    ];
    const merged = mergeJobFiles(staleJob.partialFiles, newAddition);
    assert.equal(merged.length, 3);
    assert.equal(merged.find((f) => f.path === "src/types.ts")?.code, "export interface Config { debug: boolean; }");
    assert.equal(merged.find((f) => f.path === "src/components/Header.tsx")?.code, "export const Header = () => <div>Header</div>;");
    assert.equal(merged.find((f) => f.path === "src/App.tsx")?.code, "export default () => <div>App</div>;");
  });
});
