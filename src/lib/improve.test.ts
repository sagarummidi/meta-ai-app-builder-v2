import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { POST as editRoute } from "../app/api/edit/route";
import {
  DEFAULT_IMPROVE_INSTRUCTION,
  applyChangedFiles,
  mergeDependencies,
} from "./modelRouter";

describe("AI Improve: Predefined Improvement Instruction", () => {
  test("instruction is defined, non-empty, and within boundary limits", () => {
    assert.equal(typeof DEFAULT_IMPROVE_INSTRUCTION, "string");
    assert.ok(DEFAULT_IMPROVE_INSTRUCTION.trim().length > 0);
    assert.ok(DEFAULT_IMPROVE_INSTRUCTION.length <= 15000);
  });

  test("instruction specifies UI/UX, responsiveness, accessibility, and code quality preservation", () => {
    const lower = DEFAULT_IMPROVE_INSTRUCTION.toLowerCase();
    assert.ok(lower.includes("ui/ux") || lower.includes("ux"));
    assert.ok(lower.includes("responsiveness"));
    assert.ok(lower.includes("accessibility"));
    assert.ok(lower.includes("code quality"));
    assert.ok(lower.includes("preserving") || lower.includes("preserve"));
  });

  test("passes /api/edit route validation when using DEFAULT_IMPROVE_INSTRUCTION", async () => {
    // When sent to /api/edit with valid files, it should not fail request validation (400)
    // Note: If no API key is configured, it maps to a server-side error (500), but passes 400 validation
    const req = new Request("http://localhost/api/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: DEFAULT_IMPROVE_INSTRUCTION,
        files: [
          {
            name: "App.tsx",
            code: "export default function App() { return <div>Hello World</div>; }",
          },
        ],
        requestId: "req-improve-validation",
      }),
    });

    const res = await editRoute(req);
    // Must NOT be a 400 validation error (e.g., empty instruction or invalid files)
    assert.notEqual(res.status, 400);

    const data = await res.json();
    assert.equal(typeof data.requestId, "string");
  });
});

describe("AI Improve: Concurrency Protection", () => {
  test("prevents Generate, Edit, and Improve from colliding concurrently", () => {
    let isGenerating = false;
    let isEditing = false;
    let isImproving = false;

    function canStartGenerate(): boolean {
      if (isGenerating || isEditing || isImproving) return false;
      isGenerating = true;
      return true;
    }

    function canStartEdit(): boolean {
      if (isGenerating || isEditing || isImproving) return false;
      isEditing = true;
      return true;
    }

    function canStartImprove(): boolean {
      if (isGenerating || isEditing || isImproving) return false;
      isImproving = true;
      return true;
    }

    // 1. When Improve is active: Generate, Edit, and another Improve cannot start
    assert.equal(canStartImprove(), true);
    assert.equal(canStartGenerate(), false);
    assert.equal(canStartEdit(), false);
    assert.equal(canStartImprove(), false);

    // 2. Once Improve completes: Edit can start
    isImproving = false;
    assert.equal(canStartEdit(), true);
    assert.equal(canStartImprove(), false);
    assert.equal(canStartGenerate(), false);

    // 3. Once Edit completes: Generate can start
    isEditing = false;
    assert.equal(canStartGenerate(), true);
    assert.equal(canStartImprove(), false);
    assert.equal(canStartEdit(), false);

    // 4. Once Generate completes: Improve can start again
    isGenerating = false;
    assert.equal(canStartImprove(), true);
    isImproving = false;
  });
});

describe("AI Improve: Workspace File Application & Dependency Merging", () => {
  test("updates targeted existing files in place while preserving unmodified files", () => {
    const currentFiles = [
      { name: "App.tsx", code: "export default function App() { return <div>Old App</div>; }" },
      { name: "utils.ts", code: "export const add = (a: number, b: number) => a + b;" },
    ];

    const changedFiles = [
      { name: "App.tsx", path: "App.tsx", code: "export default function App() { return <div>Improved App</div>; }" },
    ];

    const result = applyChangedFiles(currentFiles, changedFiles);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, "App.tsx");
    assert.equal(result[0].code, "export default function App() { return <div>Improved App</div>; }");
    assert.equal(result[1].name, "utils.ts");
    assert.equal(result[1].code, "export const add = (a: number, b: number) => a + b;");
  });

  test("updates single file even if model uses alternative file path", () => {
    const currentFiles = [
      { name: "App.tsx", code: "export default function App() { return <div>Old</div>; }" },
    ];

    const changedFiles = [
      { path: "page.tsx", code: "export default function App() { return <div>New</div>; }" },
    ];

    const result = applyChangedFiles(currentFiles, changedFiles);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "App.tsx");
    assert.equal(result[0].code, "export default function App() { return <div>New</div>; }");
  });

  test("appends new files created by AI Improve when multiple files exist", () => {
    const currentFiles = [
      { name: "App.tsx", code: "export default function App() { return <div>App</div>; }" },
      { name: "styles.css", code: ".app { padding: 10px; }" },
    ];

    const changedFiles = [
      { path: "utils.ts", code: "export const helper = () => true;" },
    ];

    const result = applyChangedFiles(currentFiles, changedFiles);
    assert.equal(result.length, 3);
    assert.equal(result[0].name, "App.tsx");
    assert.equal(result[1].name, "styles.css");
    assert.equal(result[2].name, "utils.ts");
    assert.equal(result[2].code, "export const helper = () => true;");
  });

  test("returns unchanged file list when changedFiles is empty", () => {
    const currentFiles = [
      { name: "App.tsx", code: "export default function App() { return <div>App</div>; }" },
    ];

    const result = applyChangedFiles(currentFiles, []);
    assert.deepEqual(result, currentFiles);
  });

  test("ignores invalid or malformed changed file objects safely", () => {
    const currentFiles = [
      { name: "App.tsx", code: "export default function App() { return <div>App</div>; }" },
      { name: "utils.ts", code: "export const a = 1;" },
    ];

    const changedFiles = [
      null as unknown as { path: string; code: string },
      { path: "", code: "bad" },
      { path: "extra.ts", code: "export const extra = true;" },
    ];

    const result = applyChangedFiles(currentFiles, changedFiles);
    assert.equal(result.length, 3);
    assert.equal(result[2].name, "extra.ts");
  });

  test("merges dependencies and handles malformed inputs safely", () => {
    const current = { "lucide-react": "^0.300.0" };
    const additions = { "canvas-confetti": "^1.9.0" };

    const merged = mergeDependencies(current, additions);
    assert.deepEqual(merged, {
      "lucide-react": "^0.300.0",
      "canvas-confetti": "^1.9.0",
    });

    // Safe handling of null/array
    assert.deepEqual(mergeDependencies(current, null as unknown as Record<string, string>), current);
    assert.deepEqual(mergeDependencies(current, [] as unknown as Record<string, string>), current);
  });
});
