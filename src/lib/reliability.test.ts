import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  getErrorStatusCode,
  sanitizeErrorMessage,
  isRetryableModelError,
  getFallbackChain,
  MODEL_CAPABILITIES,
} from "./modelRouter";

describe("Reliability Hardening: Input Validation", () => {
  const MAX_PROMPT_LENGTH = 15000;
  const MAX_INSTRUCTION_LENGTH = 15000;

  function validatePromptInput(prompt: unknown): { valid: boolean; error?: string } {
    if (typeof prompt !== "string" || !prompt.trim()) {
      return { valid: false, error: "Please provide a prompt." };
    }
    if (prompt.trim().length > MAX_PROMPT_LENGTH) {
      return {
        valid: false,
        error: `Prompt exceeds maximum allowed length of ${MAX_PROMPT_LENGTH.toLocaleString()} characters.`,
      };
    }
    return { valid: true };
  }

  function validateEditInput(
    instruction: unknown,
    files: unknown
  ): { valid: boolean; error?: string } {
    if (typeof instruction !== "string" || !instruction.trim()) {
      return { valid: false, error: "Please provide an edit instruction." };
    }
    if (instruction.trim().length > MAX_INSTRUCTION_LENGTH) {
      return {
        valid: false,
        error: `Edit instruction exceeds maximum allowed length of ${MAX_INSTRUCTION_LENGTH.toLocaleString()} characters.`,
      };
    }
    if (!Array.isArray(files) || files.length === 0) {
      return { valid: false, error: "Please provide the current project files." };
    }
    const validFiles = files.filter(
      (f) => f && typeof f === "object" && typeof (f as { name?: unknown }).name === "string"
    );
    if (validFiles.length === 0) {
      return { valid: false, error: "Please provide valid project files." };
    }
    return { valid: true };
  }

  test("rejects empty prompt", () => {
    const res = validatePromptInput("");
    assert.equal(res.valid, false);
    assert.equal(res.error, "Please provide a prompt.");
  });

  test("rejects whitespace-only prompt", () => {
    const res = validatePromptInput("   \n\t  ");
    assert.equal(res.valid, false);
    assert.equal(res.error, "Please provide a prompt.");
  });

  test("rejects non-string prompt types", () => {
    assert.equal(validatePromptInput(null).valid, false);
    assert.equal(validatePromptInput(undefined).valid, false);
    assert.equal(validatePromptInput(12345).valid, false);
    assert.equal(validatePromptInput({ text: "app" }).valid, false);
  });

  test("rejects excessively large prompt (> 15,000 characters)", () => {
    const hugePrompt = "a".repeat(15001);
    const res = validatePromptInput(hugePrompt);
    assert.equal(res.valid, false);
    assert.match(res.error || "", /exceeds maximum allowed length/);
  });

  test("accepts valid prompt within boundaries", () => {
    const validPrompt = "Build a lightweight markdown editor";
    const res = validatePromptInput(validPrompt);
    assert.equal(res.valid, true);
    assert.equal(res.error, undefined);
  });

  test("rejects empty or whitespace-only edit instruction", () => {
    const dummyFiles = [{ name: "App.tsx", code: "export default function App() {}" }];
    assert.equal(validateEditInput("", dummyFiles).valid, false);
    assert.equal(validateEditInput("   ", dummyFiles).valid, false);
    assert.equal(validateEditInput(null, dummyFiles).valid, false);
  });

  test("rejects excessively large edit instruction", () => {
    const dummyFiles = [{ name: "App.tsx", code: "export default function App() {}" }];
    const hugeInstruction = "b".repeat(15001);
    const res = validateEditInput(hugeInstruction, dummyFiles);
    assert.equal(res.valid, false);
    assert.match(res.error || "", /exceeds maximum allowed length/);
  });

  test("rejects empty or invalid project files for edit", () => {
    assert.equal(validateEditInput("Add button", []).valid, false);
    assert.equal(validateEditInput("Add button", null).valid, false);
    assert.equal(validateEditInput("Add button", [{}]).valid, false);
  });
});

describe("Reliability Hardening: Duplicate Request Protection", () => {
  test("synchronously blocks overlapping requests while in-flight", async () => {
    let isInFlight = false;
    let executionCount = 0;

    async function safeAction(): Promise<{ executed: boolean }> {
      if (isInFlight) {
        return { executed: false };
      }
      isInFlight = true;
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        executionCount++;
        return { executed: true };
      } finally {
        isInFlight = false;
      }
    }

    // Fire two actions concurrently
    const [res1, res2] = await Promise.all([safeAction(), safeAction()]);

    assert.equal(res1.executed, true);
    assert.equal(res2.executed, false);
    assert.equal(executionCount, 1);

    // After completion, sequential request is permitted
    const res3 = await safeAction();
    assert.equal(res3.executed, true);
    assert.equal(executionCount, 2);
  });

  test("prevents edit and regenerate from colliding concurrently", async () => {
    let isGenerating = false;
    let isEditing = false;

    function canStartGenerate(): boolean {
      if (isGenerating || isEditing) return false;
      isGenerating = true;
      return true;
    }

    function canStartEdit(): boolean {
      if (isGenerating || isEditing) return false;
      isEditing = true;
      return true;
    }

    // When generate is running, edit cannot start
    assert.equal(canStartGenerate(), true);
    assert.equal(canStartEdit(), false);
    assert.equal(canStartGenerate(), false);

    // Once generate finishes, edit can start
    isGenerating = false;
    assert.equal(canStartEdit(), true);
    assert.equal(canStartGenerate(), false);
  });
});

describe("Reliability Hardening: API Error Handling & Status Codes", () => {
  test("maps missing server configuration to 500", () => {
    assert.equal(getErrorStatusCode(new Error("MODEL_API_KEY is not configured.")), 500);
    assert.equal(getErrorStatusCode(new Error("API key is not configured")), 500);
  });

  test("maps real 401 authentication and unauthorized failures to 401", () => {
    assert.equal(getErrorStatusCode(new Error("NVIDIA API authentication failed (401).")), 401);
    assert.equal(getErrorStatusCode(new Error("Unauthorized access")), 401);
    assert.equal(getErrorStatusCode(new Error("Invalid api key provided")), 401);
    assert.equal(getErrorStatusCode({ status: 401 }), 401);
    assert.equal(getErrorStatusCode({ statusCode: 401 }), 401);
  });

  test("maps rate limits to 429 and preserves status for retryability and error classification", () => {
    const errorWithStatus = Object.assign(new Error("rate limit exceeded"), { status: 429 });
    assert.equal(getErrorStatusCode(errorWithStatus), 429);
    assert.equal(isRetryableModelError(errorWithStatus), true);

    assert.equal(getErrorStatusCode(new Error("NVIDIA API rate limit exceeded (429).")), 429);
    assert.equal(getErrorStatusCode(new Error("RESOURCE_EXHAUSTED: quota exceeded")), 429);
  });

  test("maps invalid user requests and validation errors to 400", () => {
    assert.equal(getErrorStatusCode(new Error("Selected model 'xyz' is not valid or available")), 400);
    assert.equal(getErrorStatusCode(new Error("Please provide a prompt.")), 400);
    assert.equal(getErrorStatusCode(new Error("Invalid JSON request body.")), 400);
    assert.equal(getErrorStatusCode(new Error("Prompt exceeds maximum allowed length of 15,000 characters.")), 400);
  });

  test("maps timeouts and gateway failures to 504 / 502 / 503 and preserves status", () => {
    const error503 = Object.assign(new Error("service failure"), { statusCode: 503 });
    assert.equal(getErrorStatusCode(error503), 503);
    assert.equal(isRetryableModelError(error503), true);

    assert.equal(getErrorStatusCode(new Error("Gateway timeout occurred")), 504);
    assert.equal(getErrorStatusCode(new Error("Request timeout")), 504);
    assert.equal(getErrorStatusCode(new Error("NVIDIA API error (502): Bad Gateway")), 502);
    assert.equal(getErrorStatusCode(new Error("NVIDIA API network request failed: fetch failed")), 503);
    assert.equal(getErrorStatusCode(new Error("Service unavailable (503)")), 503);
  });

  test("respects explicit numeric status codes on error objects", () => {
    assert.equal(getErrorStatusCode({ status: 403 }), 403);
    assert.equal(getErrorStatusCode({ statusCode: 429 }), 429);
    assert.equal(getErrorStatusCode({ status: 502 }), 502);
    assert.equal(getErrorStatusCode({ status: 500 }), 500);
  });
});

describe("Reliability Hardening: Security & Secret Sanitization", () => {
  test("redacts Meta API keys from error messages", () => {
    const rawHyphen = "Error: invalid key meta-abc123XYZ_456-secret at endpoint";
    const sanitizedHyphen = sanitizeErrorMessage(rawHyphen);
    assert.equal(sanitizedHyphen.includes("meta-abc123XYZ_456-secret"), false);
    assert.match(sanitizedHyphen, /\[REDACTED\]/);

    const rawUnderscore = "Error: invalid key meta_abc123XYZ_456_secret at endpoint";
    const sanitizedUnderscore = sanitizeErrorMessage(rawUnderscore);
    assert.equal(sanitizedUnderscore.includes("meta_abc123XYZ_456_secret"), false);
    assert.match(sanitizedUnderscore, /\[REDACTED\]/);
  });
  test("redacts NVIDIA API keys from error messages", () => {
    const raw = "Error: invalid key nvapi-abc123XYZ_456-secret at endpoint";
    const sanitized = sanitizeErrorMessage(raw);
    assert.equal(sanitized.includes("nvapi-abc123XYZ_456-secret"), false);
    assert.match(sanitized, /\[REDACTED\]/);
  });

  test("redacts Nebius API keys from error messages", () => {
    const rawHyphen = "Error: invalid key nebius-abc123XYZ_456-secret at endpoint";
    const sanitizedHyphen = sanitizeErrorMessage(rawHyphen);
    assert.equal(sanitizedHyphen.includes("nebius-abc123XYZ_456-secret"), false);
    assert.match(sanitizedHyphen, /\[REDACTED\]/);

    const rawUnderscore = "Error: invalid key nebius_abc123XYZ_456_secret at endpoint";
    const sanitizedUnderscore = sanitizeErrorMessage(rawUnderscore);
    assert.equal(sanitizedUnderscore.includes("nebius_abc123XYZ_456_secret"), false);
    assert.match(sanitizedUnderscore, /\[REDACTED\]/);
  });

  test("redacts Gemini API keys from error messages", () => {
    const raw = "Request failed with AIzaSyAbc123Def456Ghi789Jkl012Mno345Pq";
    const sanitized = sanitizeErrorMessage(raw);
    assert.equal(sanitized.includes("AIzaSyAbc123Def456Ghi789Jkl012Mno345Pq"), false);
    assert.match(sanitized, /\[REDACTED\]/);
  });

  test("redacts Bearer tokens from error messages", () => {
    const raw = "Header Authorization: Bearer token_secret_1234567890_abcdef was rejected";
    const sanitized = sanitizeErrorMessage(raw);
    assert.equal(sanitized.includes("token_secret_1234567890_abcdef"), false);
    assert.match(sanitized, /Bearer \[REDACTED\]/);
  });

  test("redacts query param keys from error messages", () => {
    const raw = "Failed to fetch https://api.example.com/v1?key=secretApiKey1234567890ABCDEF&v=1";
    const sanitized = sanitizeErrorMessage(raw);
    assert.equal(sanitized.includes("secretApiKey1234567890ABCDEF"), false);
    assert.match(sanitized, /key=\[REDACTED\]/);
  });

  test("handles null or non-string messages safely", () => {
    assert.equal(sanitizeErrorMessage("" as string), "An unexpected error occurred.");
    assert.equal(sanitizeErrorMessage(null as unknown as string), "An unexpected error occurred.");
  });
});

describe("Reliability Hardening: AI Output Validation", () => {
  function validateAndParseProjectOutput(rawJsonText: string) {
    let result: unknown;
    try {
      result = JSON.parse(rawJsonText);
    } catch {
      throw new Error("Provider returned malformed JSON that could not be parsed.");
    }

    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Provider returned invalid JSON structure (expected an object).");
    }

    const res = result as { files?: unknown; dependencies?: unknown };

    if (!res.files || !Array.isArray(res.files) || res.files.length === 0) {
      throw new Error("Provider returned an empty project with no files.");
    }

    const validFiles: { path: string; code: string }[] = [];
    for (const file of res.files) {
      if (!file || typeof file !== "object") continue;
      const f = file as { path?: unknown; code?: unknown };
      const path = typeof f.path === "string" ? f.path.trim() : "";
      const code = typeof f.code === "string" ? f.code : "";
      if (path && code) {
        validFiles.push({ path, code });
      }
    }

    if (validFiles.length === 0) {
      throw new Error("Provider returned no valid files with code.");
    }

    const rawDeps = res.dependencies;
    const dependencies: Record<string, string> = {};
    if (rawDeps && typeof rawDeps === "object" && !Array.isArray(rawDeps)) {
      for (const [key, val] of Object.entries(rawDeps)) {
        if (typeof key === "string" && key.trim()) {
          dependencies[key.trim()] = typeof val === "string" ? val : String(val ?? "latest");
        }
      }
    }

    return { files: validFiles, dependencies };
  }

  test("handles malformed JSON cleanly without unhandled exception", () => {
    assert.throws(
      () => validateAndParseProjectOutput("{ invalid json text"),
      /malformed JSON/
    );
  });

  test("rejects non-object responses (e.g. JSON array or primitive)", () => {
    assert.throws(
      () => validateAndParseProjectOutput("[\"not an object\"]"),
      /invalid JSON structure/
    );
    assert.throws(
      () => validateAndParseProjectOutput("\"just a string\""),
      /invalid JSON structure/
    );
  });

  test("rejects empty project with no files", () => {
    assert.throws(
      () => validateAndParseProjectOutput("{\"files\": [], \"dependencies\": {}}"),
      /empty project with no files/
    );
  });

  test("filters out invalid/null file objects and extracts valid files", () => {
    const output = JSON.stringify({
      files: [
        null,
        { path: "", code: "empty" },
        { path: "App.tsx", code: "export default function App() { return <div>App</div>; }" },
        { path: 123, code: 456 },
      ],
      dependencies: { "lucide-react": "latest", invalidVal: 1.2 },
    });

    const parsed = validateAndParseProjectOutput(output);
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].path, "App.tsx");
    assert.equal(parsed.dependencies["lucide-react"], "latest");
    assert.equal(parsed.dependencies["invalidVal"], "1.2");
  });

  test("safely handles non-object dependencies", () => {
    const output = JSON.stringify({
      files: [{ path: "App.tsx", code: "export default function App() {}" }],
      dependencies: ["lucide-react", "react"],
    });

    const parsed = validateAndParseProjectOutput(output);
    assert.deepEqual(parsed.dependencies, {});
  });
});

describe("Model Configuration & Fallback Policy", () => {
  test("Meta provider configuration is defined and fallback chain is empty", () => {
    assert.equal(Object.keys(MODEL_CAPABILITIES).length, 1);
    assert.equal(MODEL_CAPABILITIES["muse-spark-1.3"].provider, "meta");
    const fallbackMeta = getFallbackChain("muse-spark-1.3");
    assert.deepEqual(fallbackMeta, []);
  });

  test("retryable error classification remains intact", () => {
    assert.equal(isRetryableModelError(new Error("503 Service Unavailable")), true);
    assert.equal(isRetryableModelError(new Error("429 Too Many Requests")), true);
    assert.equal(isRetryableModelError(new Error("MODEL_API_KEY is not configured.")), false);
    assert.equal(isRetryableModelError(new Error("Selected model is not valid")), false);
  });

  test("retains status and statusCode on error objects for error classification", () => {
    // Simulate error with status 429 and a secret in the message
    const rawError429 = Object.assign(
      new Error("Meta quota exceeded with key meta-abc123Def456Ghi789"),
      { status: 429 }
    );
    const sanitized429 = new Error(sanitizeErrorMessage(rawError429.message));
    (sanitized429 as unknown as { status: number }).status = rawError429.status;
    (sanitized429 as unknown as { statusCode: number }).statusCode = rawError429.status;

    assert.equal(sanitized429.message.includes("meta-abc123Def456Ghi789"), false);
    assert.match(sanitized429.message, /\[REDACTED\]/);
    assert.equal((sanitized429 as unknown as { status: number }).status, 429);
    assert.equal(isRetryableModelError(sanitized429), true);
    assert.equal(getErrorStatusCode(sanitized429), 429);

    // Simulate upstream error with statusCode 503
    const rawError503 = Object.assign(new Error("Meta upstream service unavailable"), {
      statusCode: 503,
    });
    const sanitized503 = new Error(sanitizeErrorMessage(rawError503.message));
    (sanitized503 as unknown as { statusCode: number }).statusCode = rawError503.statusCode;
    (sanitized503 as unknown as { status: number }).status = rawError503.statusCode;

    assert.equal((sanitized503 as unknown as { statusCode: number }).statusCode, 503);
    assert.equal(isRetryableModelError(sanitized503), true);
    assert.equal(getErrorStatusCode(sanitized503), 503);

    // Missing API key error has no status property and maps to 500
    const missingKeyError = new Error("MODEL_API_KEY is not configured.");
    assert.equal(isRetryableModelError(missingKeyError), false);
    assert.equal(getErrorStatusCode(missingKeyError), 500);

    // Real 401 error maps to 401 and is not retryable
    const rawAuthError = Object.assign(new Error("Meta API authentication failed (401)."), {
      status: 401,
    });
    const sanitizedAuth = new Error(sanitizeErrorMessage(rawAuthError.message));
    (sanitizedAuth as unknown as { status: number }).status = rawAuthError.status;
    assert.equal(isRetryableModelError(sanitizedAuth), false);
    assert.equal(getErrorStatusCode(sanitizedAuth), 401);
  });
});
