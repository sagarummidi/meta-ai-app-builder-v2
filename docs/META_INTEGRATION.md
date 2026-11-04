# Meta Muse Spark Integration Guide

This document describes the direct integration between the **Meta AI App Builder** and the **Meta Muse Spark 1.3 (`muse-spark-1.3`)** inference model.

---

## 1. Integration Overview

The Meta AI App Builder uses Meta as its **exclusive AI provider**. All AI capabilities across the platform route directly through the `MetaProvider` adapter:

| Capability | Backend Endpoint | Target Model | Format |
| :--- | :--- | :--- | :--- |
| **App Generation** | `POST /api/generate` | `muse-spark-1.3` | Staged Multi-turn JSON |
| **Code Editing** | `POST /api/edit` | `muse-spark-1.3` | Structured Diff JSON |
| **Syntax Self-Repair** | `POST /api/agent` | `muse-spark-1.3` | Targeted Diagnostic JSON |

There are no secondary providers, multi-model dropdowns, or cross-provider fallback chains.

---

## 2. API Configuration & Environment Setup

### Environment Variables

Configure the server environment in `.env.local`:

```ini
# Core AI Provider Configuration (Meta-Only)
AI_PROVIDER=meta

# Meta Model API Key (Server-side only)
MODEL_API_KEY=your_meta_api_key_here

# Optional: Meta API Base URL override (defaults to https://api.meta.ai/v1)
# META_BASE_URL=https://api.meta.ai/v1

# Optional: Request Timeout in milliseconds (defaults to 600000 = 10 minutes)
# META_TIMEOUT_MS=600000
```

> [!SECURITY]
> **Client Isolation:** `MODEL_API_KEY` is read exclusively on the server. Next.js does not prefix it with `NEXT_PUBLIC_`, ensuring it is never transmitted to the browser client.

---

## 3. Provider Implementation (`src/lib/modelRouter.ts`)

The `MetaProvider` class implements `IModelProvider`:

### A. Endpoint & Authentication
- **Endpoint:** `POST https://api.meta.ai/v1/chat/completions`
- **Headers:**
  ```http
  Content-Type: application/json
  Authorization: Bearer <MODEL_API_KEY>
  ```

### B. Payload Structure
```json
{
  "model": "muse-spark-1.3",
  "messages": [
    {
      "role": "user",
      "content": "<Generated prompt with strict schema instructions>"
    }
  ],
  "temperature": 0.2,
  "max_tokens": 16000,
  "response_format": { "type": "json_object" }
}
```

### C. Output Token Truncation Detection
When generating long multi-file codebases, Meta Muse Spark may reach the output token boundary. The adapter normalizes finish reasons:
- `finish_reason === "length"`: Marks response as `truncated: true`.
- Triggers the string-aware recovery pipeline in `src/lib/jsonRecovery.ts` to preserve completed files and continue generation without data loss.

---

## 4. How Each Capability Uses Meta Muse Spark

### 1. Multi-Stage Application Generation (`POST /api/generate`)
To avoid single-turn token exhaustion, generation is partitioned into stages:
- **Stage 1 (Plan)**: Meta Muse Spark outputs a JSON file list, component hierarchy, and dependency list.
- **Stage 2 (Shared Types)**: Meta Muse Spark generates `types.ts` defining data models and prop interfaces.
- **Stage 3 (Components)**: Meta Muse Spark generates modular UI components imported from `types.ts`.
- **Stage 4 (App Orchestrator)**: Meta Muse Spark generates the root `App.tsx` importing Stage 2 and Stage 3 files.
- **Stage 5 (Validation & Auto-Repair)**: Detects missing local imports and prompts Meta Muse Spark to generate missing modules.

### 2. Natural Language AI Edit (`POST /api/edit`)
- Formats existing workspace files into markdown code fences.
- Prompts Meta Muse Spark with instruction and strict JSON schema (`changedFiles`, `dependencies`).
- Merges updated files atomically into the workspace.

### 3. User-Triggered Syntax Self-Repair (`POST /api/agent`)
- Fast-paths valid workspaces (0 calls, 0 token cost).
- If syntax diagnostics exist, formats exact compiler errors (file, line, column, error code, snippet).
- Asks Meta Muse Spark to repair the specific syntax defect without altering unaffected files.
- Bounded to a maximum of 2 attempts.

---

## 5. Reliability, Timeouts & Error Handling

### 10-Minute Timeout Protection
Meta Muse Spark generates extensive codebases that may take multiple turns. The client and server honor a **10-minute timeout window** (`600,000ms`):
- `AbortController` monitors elapsed time across turns.
- If the deadline expires, the server aborts the request and returns HTTP 504 with a sanitized explanation.

### Rate Limiting & Concurrency Control (`src/lib/rateLimiter.ts`)
- In-memory rate limiting throttles requests per IP:
  - `generate`: 5 requests per minute
  - `edit`: 10 requests per minute
  - `agent`: 20 requests per minute
- `ConcurrencyLimiter` restricts simultaneous model invocations to 3 to prevent API flooding.

### Secret Redaction & Error Sanitization
All error messages pass through `sanitizeErrorMessage()`:
- Automatically redacts API keys, Bearer tokens, and sensitive credential formats before errors reach the user interface.
