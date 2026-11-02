import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRepairPayload,
  computeWorkspaceFingerprint,
  isWorkspaceStale,
  canStartRepair,
  truncateErrorMessage,
  deduplicateErrors,
  parseRepairResponse,
  mapRepairedFilesToAppFiles,
} from "./uiHelpers";

describe("Agent UI Helpers: buildRepairPayload", () => {
  it("throws clear error when files array is empty or invalid", () => {
    assert.throws(
      () => buildRepairPayload([]),
      /files list must be a non-empty array/
    );
    assert.throws(
      () => buildRepairPayload(null as unknown as []),
      /files list must be a non-empty array/
    );
  });

  it("normalizes .name and .path into VirtualFiles with trimmed paths", () => {
    const files = [
      { name: " App.tsx ", code: "export default function App() {}" },
      { path: "components/Button.tsx", code: "export const Button = () => null;" },
    ];

    const payload = buildRepairPayload(files, "meta", "muse-spark-1.3", "custom-req-123");

    assert.equal(payload.requestId, "custom-req-123");
    assert.equal(payload.provider, "meta");
    assert.equal(payload.model, "muse-spark-1.3");
    assert.equal(payload.files.length, 2);
    assert.deepEqual(payload.files[0], {
      path: "App.tsx",
      code: "export default function App() {}",
    });
    assert.deepEqual(payload.files[1], {
      path: "components/Button.tsx",
      code: "export const Button = () => null;",
    });
  });

  it("generates an automatic requestId when none is provided", () => {
    const files = [{ name: "App.tsx", code: "const x = 1;" }];
    const payload = buildRepairPayload(files);

    assert.ok(payload.requestId.startsWith("req-repair-"));
  });
});

describe("Agent UI Helpers: Workspace Fingerprinting & Stale Detection", () => {
  it("produces deterministic fingerprints irrespective of file order", () => {
    const filesA = [
      { name: "a.tsx", code: "code A" },
      { name: "b.tsx", code: "code B" },
    ];
    const filesB = [
      { name: "b.tsx", code: "code B" },
      { name: "a.tsx", code: "code A" },
    ];

    const fpA = computeWorkspaceFingerprint(filesA);
    const fpB = computeWorkspaceFingerprint(filesB);

    assert.equal(fpA, fpB);
    assert.equal(isWorkspaceStale(fpA, filesB), false);
  });

  it("detects workspace modifications as stale", () => {
    const initialFiles = [{ name: "App.tsx", code: "original code" }];
    const fp = computeWorkspaceFingerprint(initialFiles);

    const modifiedFiles = [{ name: "App.tsx", code: "user edited code" }];
    assert.equal(isWorkspaceStale(fp, modifiedFiles), true);
  });

  it("detects addition or removal of files as stale", () => {
    const initialFiles = [{ name: "App.tsx", code: "code" }];
    const fp = computeWorkspaceFingerprint(initialFiles);

    const addedFiles = [
      { name: "App.tsx", code: "code" },
      { name: "Utils.ts", code: "export const u = 1;" },
    ];
    assert.equal(isWorkspaceStale(fp, addedFiles), true);

    const emptyFiles: { name: string; code: string }[] = [];
    assert.equal(isWorkspaceStale(fp, emptyFiles), true);
  });
});

describe("Agent UI Helpers: Concurrency Guard (canStartRepair)", () => {
  it("prevents repair when already busy or repairing", () => {
    assert.equal(canStartRepair(true, false), false);
    assert.equal(canStartRepair(false, true), false);
    assert.equal(canStartRepair(true, true), false);
    assert.equal(canStartRepair(false, false), true);
  });
});

describe("Agent UI Helpers: truncateErrorMessage", () => {
  it("returns message as is if within limit", () => {
    const msg = "Short syntax error message";
    assert.equal(truncateErrorMessage(msg, 50), msg);
  });

  it("truncates message longer than limit and appends ellipsis", () => {
    const longMsg = "This is a very long error message detailing multiple compiler syntax diagnostics across various files in the workspace.";
    const truncated = truncateErrorMessage(longMsg, 30);

    assert.ok(truncated.endsWith("..."));
    assert.ok(truncated.length <= 33);
  });

  it("handles null, undefined, and non-string values safely", () => {
    assert.equal(truncateErrorMessage(null), "");
    assert.equal(truncateErrorMessage(undefined), "");
    assert.equal(truncateErrorMessage(12345), "12345");
  });
});

describe("Agent UI Helpers: deduplicateErrors", () => {
  it("removes duplicate messages preserving order", () => {
    const raw = [
      "SyntaxError: Unexpected token",
      "TS1005: ';' expected",
      "SyntaxError: Unexpected token",
      "TS1128: Declaration or statement expected",
      "TS1005: ';' expected",
    ];

    const deduplicated = deduplicateErrors(raw);
    assert.deepEqual(deduplicated, [
      "SyntaxError: Unexpected token",
      "TS1005: ';' expected",
      "TS1128: Declaration or statement expected",
    ]);
  });

  it("ignores empty or whitespace-only messages and non-string items", () => {
    const raw = ["", "  ", null, "Actual error", undefined, "Actual error"];
    const result = deduplicateErrors(raw);

    assert.deepEqual(result, ["Actual error"]);
  });
});

describe("Agent UI Helpers: parseRepairResponse", () => {
  it("throws on empty or whitespace response text", () => {
    assert.throws(() => parseRepairResponse(""), /server returned an empty response/);
    assert.throws(() => parseRepairResponse("   "), /server returned an empty response/);
  });

  it("throws on invalid JSON response", () => {
    assert.throws(() => parseRepairResponse("<html>502 Bad Gateway</html>"), /Invalid response format/);
  });

  it("throws on non-object JSON responses", () => {
    assert.throws(() => parseRepairResponse("[]"), /Server response must be an object/);
    assert.throws(() => parseRepairResponse('"hello"'), /Server response must be an object/);
  });

  it("parses valid success response correctly", () => {
    const validJson = JSON.stringify({
      success: true,
      requestId: "req-123",
      repaired: true,
      attempts: 1,
      initialDiagnostics: [{ path: "App.tsx", line: 5, character: 10, message: "TS1005" }],
      remainingDiagnostics: [],
      files: [{ path: "App.tsx", code: "export default function App() { return <div>Fixed</div>; }" }],
      outcomeReason: "Repaired all syntax errors in 1 attempt.",
      usedModel: "muse-spark-1.3",
      usedProvider: "meta",
    });

    const parsed = parseRepairResponse(validJson);
    assert.equal(parsed.success, true);
    assert.equal(parsed.requestId, "req-123");
    assert.equal(parsed.repaired, true);
    assert.equal(parsed.attempts, 1);
    assert.equal(parsed.files?.length, 1);
    assert.equal(parsed.remainingDiagnostics?.length, 0);
    assert.equal(parsed.outcomeReason, "Repaired all syntax errors in 1 attempt.");
  });

  it("parses failure response with remaining diagnostics", () => {
    const failJson = JSON.stringify({
      success: false,
      requestId: "req-fail",
      repaired: false,
      attempts: 2,
      remainingDiagnostics: [{ path: "App.tsx", line: 1, character: 1, message: "TS1005: Error" }],
      outcomeReason: "Remaining syntax errors after 2 attempts.",
    });

    const parsed = parseRepairResponse(failJson);
    assert.equal(parsed.success, false);
    assert.equal(parsed.remainingDiagnostics?.length, 1);
    assert.equal(parsed.outcomeReason, "Remaining syntax errors after 2 attempts.");
  });
});

describe("Agent UI Helpers: mapRepairedFilesToAppFiles", () => {
  it("strips leading slashes and maps to AppFile structure", () => {
    const virtualFiles = [
      { path: "/App.tsx", code: "console.log('App');" },
      { path: "components/Header.tsx", code: "console.log('Header');" },
    ];

    const appFiles = mapRepairedFilesToAppFiles(virtualFiles);

    assert.deepEqual(appFiles, [
      { name: "App.tsx", code: "console.log('App');" },
      { name: "components/Header.tsx", code: "console.log('Header');" },
    ]);
  });

  it("handles empty or non-array inputs safely", () => {
    assert.deepEqual(mapRepairedFilesToAppFiles([]), []);
    assert.deepEqual(mapRepairedFilesToAppFiles(null as unknown as []), []);
  });
});
