import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeJsonString,
  extractJsonString,
  safeParseJson,
  repairTruncatedJsonString,
  extractCompleteFilesFromTruncatedJson,
  validateGenerationOutput,
  validateEditOutput,
  mergeGeneratedFiles,
  executeGenerationPipeline,
  isFinishReasonTruncated,
  type GenerationOutput,
} from "./jsonRecovery";
import {
  ModelRouter,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  MetaProvider,
  getErrorStatusCode,
} from "./modelRouter";
import { POST as generateRoute } from "../app/api/generate/route";
import { POST as editRoute } from "../app/api/edit/route";

class MockTestProvider implements ModelProvider {
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
      throw new Error(`MockTestProvider: No more responses configured.`);
    }
    return resp;
  }
}

describe("1. Valid JSON responses", () => {
  test("parses clean standard JSON output", () => {
    const raw = JSON.stringify({
      files: [
        {
          path: "App.tsx",
          code: "export default function App() { return <div>Valid App</div>; }",
        },
      ],
      dependencies: {
        "lucide-react": "^0.300.0",
      },
    });

    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, true);
    assert.equal(parsed.isTruncated, false);
    assert.ok(parsed.data);

    const validated = validateGenerationOutput(parsed.data);
    assert.equal(validated.valid, true);
    assert.equal(validated.files?.length, 1);
    assert.equal(validated.files?.[0].path, "App.tsx");
    assert.equal(validated.dependencies?.["lucide-react"], "^0.300.0");
  });
});

describe("2. JSON surrounded by Markdown code fences", () => {
  test("extracts JSON with ```json and ``` fences", () => {
    const jsonContent = JSON.stringify({
      files: [
        {
          path: "App.tsx",
          code: "export default function App() { return <h1>Fenced JSON</h1>; }",
        },
      ],
      dependencies: {},
    });

    const raw = "```json\n" + jsonContent + "\n```";
    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, true);
    assert.equal(parsed.isTruncated, false);
    assert.equal(parsed.data?.files[0].path, "App.tsx");
  });

  test("extracts JSON with unlabelled ``` fences", () => {
    const jsonContent = JSON.stringify({
      files: [
        {
          path: "App.tsx",
          code: "export default function App() { return <p>Plain Fenced</p>; }",
        },
      ],
      dependencies: {},
    });

    const raw = "```\n" + jsonContent + "\n```";
    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.files[0].path, "App.tsx");
  });

  test("selects application JSON fence when preceded by introductory TS/TSX fence (ISS-03)", () => {
    const raw = `Here is the TypeScript type interface:
\`\`\`typescript
interface Config {
  theme: string;
}
\`\`\`
And here is the complete application structure:
\`\`\`json
{
  "files": [
    {
      "path": "App.tsx",
      "code": "export default function App() { return <div>Selected Fence</div>; }"
    }
  ],
  "dependencies": {}
}
\`\`\``;

    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.files[0].path, "App.tsx");
    assert.ok(parsed.data?.files[0].code.includes("Selected Fence"));
  });

  test("selects application JSON fence with 'files' when multiple JSON fences exist (ISS-03)", () => {
    const raw = `First, here is an example config:
\`\`\`json
{
  "exampleKey": "exampleVal"
}
\`\`\`
Now, here is the generated app:
\`\`\`json
{
  "files": [
    {
      "path": "App.tsx",
      "code": "export default function App() { return <div>Actual App</div>; }"
    }
  ],
  "dependencies": {}
}
\`\`\``;

    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.files[0].path, "App.tsx");
    assert.ok(parsed.data?.files[0].code.includes("Actual App"));
  });

  test("does not mistake arbitrary TypeScript or JavaScript code fence for application JSON (ISS-03)", () => {
    const raw = `\`\`\`tsx
export default function NotJson() {
  return <div>Not JSON at all</div>;
}
\`\`\``;

    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, false);
  });
});

describe("3. Responses containing explanatory text", () => {
  test("extracts JSON surrounded by prose before and after fences", () => {
    const jsonContent = JSON.stringify({
      files: [
        {
          path: "App.tsx",
          code: "export default function App() { return <div>With Prose</div>; }",
        },
      ],
      dependencies: {},
    });

    const raw = `Here is your complete React application with polished UI:

\`\`\`json
${jsonContent}
\`\`\`

I hope this helps! Feel free to ask if you need extra components.`;

    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.files[0].path, "App.tsx");
  });

  test("extracts JSON surrounded by prose without code fences", () => {
    const raw = `Sure! Here is the JSON configuration:
{"files":[{"path":"App.tsx","code":"export default function App() { return <div>Raw Prose</div>; }"}],"dependencies":{}}
Enjoy building your app!`;

    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.files[0].path, "App.tsx");
  });
});

describe("4. Unterminated JSON strings", () => {
  test("detects unterminated string and marks isTruncated as true", () => {
    const raw = '{"files":[{"path":"App.tsx","code":"export default function App() { return <div>Cut off';
    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, false);
    assert.equal(parsed.isTruncated, true);
  });

  test("extractJsonString detects incomplete structural termination", () => {
    const raw = '{"files":[{"path":"App.tsx","code":"hello';
    const res = extractJsonString(raw);
    assert.equal(res.isTruncated, true);
  });

  test("never treats incomplete output as successful", () => {
    const incomplete = { files: [{ path: "App.tsx", code: "const a =" }] };
    const validated = validateGenerationOutput(incomplete);
    assert.equal(validated.valid, false);
    assert.match(validated.error || "", /invalid TypeScript/i);
  });
});

describe("5. Truncated JSON caused by output limits", () => {
  test("handles 7,680 char truncated response matching Meta log failure", () => {
    let longCode = "export default function App() {\n";
    for (let i = 0; i < 500; i++) {
      longCode += `  const longConfigSettingVariableItem${i} = "data_configuration_value_${i}";\n`;
    }
    const fullPayload = JSON.stringify({
      files: [{ path: "App.tsx", code: longCode }],
      dependencies: {},
    });

    assert.ok(fullPayload.length > 10000);

    const truncated = fullPayload.slice(0, 7680);
    const parsed = safeParseJson<GenerationOutput>(truncated);

    assert.equal(parsed.success, false);
    assert.equal(parsed.isTruncated, true);
  });

  test("repairTruncatedJsonString repairs structure for partial inspection", () => {
    const truncated = '{"files":[{"path":"App.tsx","code":"console.log(1)';
    const repaired = repairTruncatedJsonString(truncated);
    assert.ok(repaired.endsWith('"}]}') || repaired.endsWith('"}'));
    const parsed = JSON.parse(repaired);
    assert.equal(parsed.files[0].path, "App.tsx");
  });
});

describe("6. Nested objects and arrays", () => {
  test("handles nested objects, arrays, and template literals in TSX", () => {
    const code = `import React from 'react';
export default function App() {
  const config = {
    theme: {
      colors: ["#ff0000", "#00ff00", { dark: "#000000" }],
      nested: { a: { b: 1 } }
    }
  };
  return <div style={{ color: config.theme.colors[0] }}>Nested test</div>;
}`;

    const raw = JSON.stringify({
      files: [{ path: "App.tsx", code }],
      dependencies: { "react-router-dom": "^6.0.0" },
    });

    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.files[0].code, code);
  });
});

describe("7. Escaped quotation marks and backslashes", () => {
  test("preserves escaped quotes and escaped backslashes without corruption", () => {
    const code = `export default function App() {
  const greeting = "He said: \\"Hello World\\"";
  const regex = /^[a-zA-Z0-9_\\\\-]+$/;
  const path = "C:\\\\projects\\\\app";
  return <div>{greeting}</div>;
}`;

    const raw = JSON.stringify({
      files: [{ path: "App.tsx", code }],
      dependencies: {},
    });

    const sanitized = sanitizeJsonString(raw);
    const parsed = JSON.parse(sanitized);
    assert.equal(parsed.files[0].code, code);
  });

  test("handles quadruple backslashes and quotes properly in sanitizer", () => {
    const codeWithBackslashes = 'const backslash = "\\\\"; const quote = "\\"";';
    const raw = JSON.stringify({
      files: [{ path: "App.tsx", code: codeWithBackslashes }],
      dependencies: {},
    });

    const sanitized = sanitizeJsonString(raw);
    const parsed = JSON.parse(sanitized);
    assert.equal(parsed.files[0].code, codeWithBackslashes);
  });
});

describe("8. Multiline React and TypeScript source code", () => {
  test("sanitizes raw literal newlines and tabs inside JSON string literals", () => {
    const raw = `{"files":[{"path":"App.tsx","code":"import React from 'react';
export default function App() {
\treturn <div>Multiline</div>;
}"}],"dependencies":{}}`;

    const sanitized = sanitizeJsonString(raw);
    const parsed = JSON.parse(sanitized);
    assert.equal(parsed.files[0].path, "App.tsx");
    assert.ok(parsed.files[0].code.includes("\n"));
  });

  test("strips trailing commas before closing braces/brackets outside strings", () => {
    const raw = `{"files":[{"path":"App.tsx","code":"export default function App() { return <div>Trailing</div>; }",},],"dependencies":{},}`;
    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.files[0].path, "App.tsx");
  });
});

describe("9. Multiple generated files", () => {
  test("extracts and validates multiple files across project", () => {
    const raw = JSON.stringify({
      files: [
        {
          path: "App.tsx",
          code: "import Header from './components/Header';\nexport default function App() { return <Header />; }",
        },
        {
          path: "components/Header.tsx",
          code: "export default function Header() { return <header>Header</header>; }",
        },
        {
          path: "types/index.ts",
          code: "export interface User { id: string; name: string; }",
        },
      ],
      dependencies: {
        "lucide-react": "latest",
      },
    });

    const parsed = safeParseJson<GenerationOutput>(raw);
    assert.equal(parsed.success, true);
    const validated = validateGenerationOutput(parsed.data);
    assert.equal(validated.valid, true);
    assert.equal(validated.files?.length, 3);
    assert.equal(validated.files?.[0].path, "App.tsx");
    assert.equal(validated.files?.[1].path, "components/Header.tsx");
    assert.equal(validated.files?.[2].path, "types/index.ts");
  });
});

describe("10. Continuation without duplicate content", () => {
  test("extracts complete files from partial response before cutoff", () => {
    const partialRaw = `{"files":[
      {"path":"App.tsx","code":"export default function App() { return <div>App</div>; }"},
      {"path":"components/Navbar.tsx","code":"export default function Navbar() { return <nav>Nav</nav>; }"},
      {"path":"components/Dashboard.tsx","code":"export default function Dashboard() { return <div`;

    const recoveredFiles = extractCompleteFilesFromTruncatedJson(partialRaw);
    assert.equal(recoveredFiles.length, 2);
    assert.equal(recoveredFiles[0].path, "App.tsx");
    assert.equal(recoveredFiles[1].path, "components/Navbar.tsx");
  });

  test("rejects closed JSON file object containing incomplete TypeScript code (ISS-01)", () => {
    const partialRaw = `{"files":[
      {"path":"App.tsx","code":"export default function App() { return <div>Valid</div>; }"},
      {"path":"components/Broken.tsx","code":"export default function Broken() { const x = "},
      {"path":"components/Dashboard.tsx","code":"export default function Dashboard() { return <div`;

    const recoveredFiles = extractCompleteFilesFromTruncatedJson(partialRaw);
    assert.equal(recoveredFiles.length, 1);
    assert.equal(recoveredFiles[0].path, "App.tsx");
  });

  test("preserves non-TS valid files such as styles.css in partial extraction (ISS-01)", () => {
    const partialRaw = `{"files":[
      {"path":"App.tsx","code":"export default function App() { return <div>Valid</div>; }"},
      {"path":"styles.css","code":".btn { background: red; }"},
      {"path":"components/CutOff.tsx","code":"export default function CutOff() { return <div`;

    const recoveredFiles = extractCompleteFilesFromTruncatedJson(partialRaw);
    assert.equal(recoveredFiles.length, 2);
    assert.equal(recoveredFiles[0].path, "App.tsx");
    assert.equal(recoveredFiles[1].path, "styles.css");
  });

  test("mergeGeneratedFiles updates existing files and appends new ones without duplicates", () => {
    const existing = [
      { path: "App.tsx", code: "export default function App() { return <div>Old</div>; }" },
      { path: "Header.tsx", code: "export default function Header() { return <div>Header</div>; }" },
    ];

    const continuation = [
      { path: "App.tsx", code: "export default function App() { return <div>Updated</div>; }" },
      { path: "Footer.tsx", code: "export default function Footer() { return <div>Footer</div>; }" },
    ];

    const merged = mergeGeneratedFiles(existing, continuation);
    assert.equal(merged.length, 3);
    assert.equal(merged.find((f) => f.path === "App.tsx")?.code.includes("Updated"), true);
    assert.ok(merged.find((f) => f.path === "Header.tsx"));
    assert.ok(merged.find((f) => f.path === "Footer.tsx"));
  });

  test("executeGenerationPipeline recovers from truncation using targeted continuation", async () => {
    const router = new ModelRouter();
    const turn1Output = `{"files":[
      {"path":"App.tsx","code":"export default function App() { return <div>App Root</div>; }"},
      {"path":"components/Card.tsx","code":"export default function Card() { return <div`;

    const turn2Output = JSON.stringify({
      files: [
        {
          path: "components/Card.tsx",
          code: "export default function Card() { return <div>Complete Card</div>; }",
        },
      ],
      dependencies: { "canvas-confetti": "latest" },
    });

    const mockProvider = new MockTestProvider([
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
      userPrompt: "Build a card display application",
      requestId: "test-continuation-req",
      maxContinuationAttempts: 2,
    });

    assert.equal(result.attemptsUsed, 2);
    assert.equal(result.files.length, 2);
    assert.equal(result.files.find((f) => f.path === "App.tsx")?.code, "export default function App() { return <div>App Root</div>; }");
    assert.equal(result.files.find((f) => f.path === "components/Card.tsx")?.code, "export default function Card() { return <div>Complete Card</div>; }");
    assert.equal(result.dependencies["canvas-confetti"], "latest");
  });
});

describe("11. Invalid file paths", () => {
  test("rejects path traversal attempts in generated files", () => {
    const raw = {
      files: [
        {
          path: "../../../etc/passwd",
          code: "export default function Hack() {}",
        },
      ],
    };

    const res = validateGenerationOutput(raw);
    assert.equal(res.valid, false);
    assert.match(res.error || "", /Security error.*Path traversal/i);
  });

  test("rejects absolute paths and root slashes", () => {
    const raw = {
      files: [
        {
          path: "/App.tsx",
          code: "export default function App() {}",
        },
      ],
    };

    const res = validateGenerationOutput(raw);
    assert.equal(res.valid, false);
    assert.match(res.error || "", /Security error.*Absolute paths/i);
  });

  test("rejects Windows drive letters and URL schemes", () => {
    const raw1 = {
      files: [{ path: "C:\\Windows\\System32\\app.tsx", code: "export default function App() {}" }],
    };
    assert.equal(validateGenerationOutput(raw1).valid, false);

    const raw2 = {
      files: [{ path: "http://malicious.com/App.tsx", code: "export default function App() {}" }],
    };
    assert.equal(validateGenerationOutput(raw2).valid, false);
  });
});

describe("12. Failed recovery after the retry limit", () => {
  test("throws clear truncation error after exhausting continuation attempts", async () => {
    const router = new ModelRouter();
    const mockProvider = new MockTestProvider([
      {
        outputText: '{"files":[{"path":"App.tsx","code":"export default function App() { return <div',
        finishReason: "length",
        truncated: true,
      },
      {
        outputText: '{"files":[{"path":"App.tsx","code":"export default function App() { return <div',
        finishReason: "length",
        truncated: true,
      },
    ]);
    router.registerProvider(mockProvider);

    await assert.rejects(
      async () => {
        await executeGenerationPipeline({
          modelRouter: router,
          provider: "meta",
          model: "muse-spark-1.3",
          userPrompt: "Build huge app",
          requestId: "test-exhaust-retry",
          maxContinuationAttempts: 1,
        });
      },
      (err: Error) => {
        assert.match(err.message, /truncated due to output token limits/i);
        assert.equal(getErrorStatusCode(err), 502);
        return true;
      }
    );
  });
});

describe("13. Meta provider compatibility", () => {
  test("MetaProvider parses finish_reason, truncated flag, and usage correctly", async () => {
    let capturedBody: string | undefined;
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: '{"files":[{"path":"App.tsx","code":"export default function App() { return <div>Meta</div>; }"}]}' },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 150,
            completion_tokens: 85,
            total_tokens: 235,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const provider = new MetaProvider({
      apiKey: "meta-mock-key-12345",
      fetchFn: mockFetch,
    });

    const res = await provider.generate({
      input: "test prompt",
      model: "muse-spark-1.3",
    });

    assert.equal(res.outputText.includes("Meta"), true);
    assert.equal(res.finishReason, "stop");
    assert.equal(res.truncated, false);
    assert.equal(res.rawUsage?.totalTokens, 235);

    const bodyJson = JSON.parse(capturedBody || "{}");
    assert.equal(bodyJson.model, "muse-spark-1.3");
  });

  test("MetaProvider flags truncated when finish_reason is length or max_tokens", async () => {
    const mockFetch = (async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: '{"files":[{"path":"App.tsx","code":"partial' },
              finish_reason: "length",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 8192,
            total_tokens: 8292,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const provider = new MetaProvider({
      apiKey: "meta-mock-key-12345",
      fetchFn: mockFetch,
    });

    const res = await provider.generate({
      input: "test prompt",
      model: "muse-spark-1.3",
    });

    assert.equal(res.finishReason, "length");
    assert.equal(res.truncated, true);
  });

  test("isFinishReasonTruncated normalizes case-insensitively and detects length, max_tokens, and MAX_TOKENS (ISS-02)", () => {
    assert.equal(isFinishReasonTruncated("length"), true);
    assert.equal(isFinishReasonTruncated("LENGTH"), true);
    assert.equal(isFinishReasonTruncated("Length"), true);
    assert.equal(isFinishReasonTruncated("max_tokens"), true);
    assert.equal(isFinishReasonTruncated("MAX_TOKENS"), true);
    assert.equal(isFinishReasonTruncated("Max_Tokens"), true);
  });

  test("isFinishReasonTruncated treats ordinary completion and empty values as non-truncated (ISS-02)", () => {
    assert.equal(isFinishReasonTruncated("stop"), false);
    assert.equal(isFinishReasonTruncated("STOP"), false);
    assert.equal(isFinishReasonTruncated("end_turn"), false);
    assert.equal(isFinishReasonTruncated("content_filter"), false);
    assert.equal(isFinishReasonTruncated(""), false);
    assert.equal(isFinishReasonTruncated(null), false);
    assert.equal(isFinishReasonTruncated(undefined), false);
  });
});

describe("14. Existing generation and editing behavior", () => {
  test("validateEditOutput accepts clean changedFiles and dependencies", () => {
    const raw = {
      changedFiles: [
        {
          path: "App.tsx",
          code: "export default function App() { return <div>Edited App</div>; }",
        },
      ],
      dependencies: {
        "date-fns": "^2.30.0",
      },
    };

    const res = validateEditOutput(raw);
    assert.equal(res.valid, true);
    assert.equal(res.changedFiles?.length, 1);
    assert.equal(res.changedFiles?.[0].path, "App.tsx");
    assert.equal(res.dependencies?.["date-fns"], "^2.30.0");
  });

  test("generateRoute returns 400 for empty prompt", async () => {
    const req = new Request("http://localhost/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });
    const res = await generateRoute(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
  });

  test("editRoute returns 400 for empty instruction", async () => {
    const req = new Request("http://localhost/api/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "",
        files: [{ name: "App.tsx", code: "export default function App() {}" }],
      }),
    });
    const res = await editRoute(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
  });
});
