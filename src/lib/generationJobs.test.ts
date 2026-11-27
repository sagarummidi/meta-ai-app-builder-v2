import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerationJobStoreManager } from "./generationJobs";

test("production without a database URL fails job operations explicitly without crashing module loading", async () => {
  const keys = [
    "DATABASE_URL",
    "POSTGRES_URL",
    "NODE_ENV",
    "NEXT_PHASE",
    "__NEXT_BUILDING_STATIC",
    "NEXT_PRIVATE_BUILD_WORKER",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  try {
    for (const key of keys) delete process.env[key];
    Reflect.set(process.env, "NODE_ENV", "production");

    const store = new GenerationJobStoreManager();
    await assert.rejects(
      store.getJobAsync("missing-job"),
      /Production database configuration missing.*DATABASE_URL or POSTGRES_URL/i
    );
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else Reflect.set(process.env, key, value);
    }
  }
});
