export type ModelProviderType = "meta";

export interface ProviderModelConfig {
  provider: ModelProviderType;
  displayName: string;
  models: { id: string; name: string; isDefault?: boolean }[];
}

export const AVAILABLE_PROVIDERS: ProviderModelConfig[] = [
  {
    provider: "meta",
    displayName: "Meta",
    models: [
      { id: "muse-spark-1.3", name: "muse-spark-1.3", isDefault: true },
    ],
  },
];

export type CapabilityCategory =
  | "general-fast"
  | "reasoning-complex"
  | "lightweight-fast";

export interface ModelCapability {
  modelId: string;
  provider: ModelProviderType;
  displayName: string;
  category: CapabilityCategory;
  description: string;
}

export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  "muse-spark-1.3": {
    modelId: "muse-spark-1.3",
    provider: "meta",
    displayName: "muse-spark-1.3",
    category: "general-fast",
    description: "Meta general-purpose app generation model",
  },
};

export interface FallbackTarget {
  provider: ModelProviderType;
  model: string;
  displayName: string;
  category: CapabilityCategory;
}

export function getFallbackChain(_primaryModelId?: string): FallbackTarget[] {
  // Single-provider Meta architecture: no multi-provider fallback chains
  void _primaryModelId;
  return [];
}

export function isRetryableModelError(error: unknown): boolean {
  if (!error) return false;

  const message = error instanceof Error ? error.message : String(error);
  const lowerMsg = message.toLowerCase();

  if (
    lowerMsg.includes("is not configured") ||
    lowerMsg.includes("authentication failed") ||
    lowerMsg.includes("401") ||
    lowerMsg.includes("403") ||
    lowerMsg.includes("unauthorized") ||
    lowerMsg.includes("is not valid or available") ||
    lowerMsg.includes("is not registered") ||
    lowerMsg.includes("please provide") ||
    lowerMsg.includes("invalid api key") ||
    lowerMsg.includes("invalid model") ||
    lowerMsg.includes("bad request") ||
    lowerMsg.includes("refused to generate") ||
    lowerMsg.includes("refusal") ||
    lowerMsg.includes("filtered by safety") ||
    lowerMsg.includes("content_filter")
  ) {
    return false;
  }

  if (
    lowerMsg.includes("429") ||
    lowerMsg.includes("500") ||
    lowerMsg.includes("502") ||
    lowerMsg.includes("503") ||
    lowerMsg.includes("504") ||
    lowerMsg.includes("empty completion") ||
    lowerMsg.includes("rate limit") ||
    lowerMsg.includes("high demand") ||
    lowerMsg.includes("overloaded") ||
    lowerMsg.includes("resource_exhausted") ||
    lowerMsg.includes("quota") ||
    lowerMsg.includes("timeout") ||
    lowerMsg.includes("network") ||
    lowerMsg.includes("fetch failed") ||
    lowerMsg.includes("temporarily unavailable") ||
    lowerMsg.includes("service unavailable") ||
    lowerMsg.includes("internal server error") ||
    lowerMsg.includes("bad gateway") ||
    lowerMsg.includes("gateway timeout")
  ) {
    return true;
  }

  if (typeof error === "object" && error !== null) {
    const status =
      (error as { status?: number; statusCode?: number }).status ||
      (error as { status?: number; statusCode?: number }).statusCode;
    if (status) {
      if (status === 429 || (status >= 500 && status <= 599)) {
        return true;
      }
      if (status === 401 || status === 403 || status === 400 || status === 404) {
        return false;
      }
    }
  }

  return false;
}

export interface ModelRequest {
  model?: string;
  input: string;
  generationConfig?: {
    thinking_level?: "low" | "medium" | "high" | "none";
    temperature?: number;
    maxOutputTokens?: number;
    [key: string]: unknown;
  };
  responseFormat?: {
    type: "text";
    mime_type: string;
    schema?: Record<string, unknown>;
  };
  requestId?: string;
  disableFallback?: boolean;
  timeoutMs?: number;
}

export interface ModelResponse {
  outputText: string;
  finishReason?: string;
  truncated?: boolean;
  rawUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface GenerateWithFallbackResult {
  response: ModelResponse;
  usedModel: string;
  usedProvider: ModelProviderType;
  primaryModel: string;
  primaryProvider: ModelProviderType;
  fallbackUsed: boolean;
  attemptedModels: Array<{ provider: ModelProviderType; model: string }>;
  fallbackNotice?: string;
}

export interface ModelProvider {
  name: ModelProviderType;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export const MAX_GENERATION_DURATION_MS = 10 * 60 * 1000; // 10 minutes (600,000 ms)
export const DEFAULT_PROVIDER_TIMEOUT_MS = MAX_GENERATION_DURATION_MS;

export function resolveProviderTimeoutMs(): number {
  const envVal = (
    process.env.META_TIMEOUT_MS ||
    process.env.AI_PROVIDER_TIMEOUT_MS ||
    process.env.MODEL_TIMEOUT_MS ||
    ""
  ).trim();
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_PROVIDER_TIMEOUT_MS;
}

export interface MetaProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

export interface MetaExtractedResponse {
  outputText: string;
  finishReason?: string;
  truncated: boolean;
  rawUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export function extractTextFromMetaResponse(data: unknown): MetaExtractedResponse {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    const err = new Error("Unexpected Meta API response structure: response body is not a JSON object.");
    (err as unknown as { status: number; statusCode: number }).status = 502;
    (err as unknown as { status: number; statusCode: number }).statusCode = 502;
    throw err;
  }

  const payload = data as Record<string, unknown>;

  // Check for error payload returned within a 200 OK
  if (payload.error) {
    let errorDetail = "Unknown upstream error";
    if (typeof payload.error === "string") {
      errorDetail = payload.error;
    } else if (typeof payload.error === "object" && payload.error !== null) {
      const errObj = payload.error as Record<string, unknown>;
      errorDetail = typeof errObj.message === "string" ? errObj.message : JSON.stringify(payload.error);
    }
    const err = new Error(sanitizeErrorMessage(`Meta API returned an error: ${errorDetail}`));
    (err as unknown as { status: number; statusCode: number }).status = 502;
    (err as unknown as { status: number; statusCode: number }).statusCode = 502;
    throw err;
  }

  const choices = payload.choices;
  let choice: Record<string, unknown> | undefined;

  if (Array.isArray(choices)) {
    if (choices.length === 0) {
      const err = new Error("Meta API returned an empty 'choices' array (0 choices).");
      (err as unknown as { status: number; statusCode: number }).status = 502;
      (err as unknown as { status: number; statusCode: number }).statusCode = 502;
      throw err;
    }
    const firstChoice = choices[0];
    if (firstChoice && typeof firstChoice === "object") {
      choice = firstChoice as Record<string, unknown>;
    }
  }

  // Check for model refusal
  if (choice) {
    const messageObj =
      choice.message && typeof choice.message === "object"
        ? (choice.message as Record<string, unknown>)
        : undefined;
    const refusal = messageObj?.refusal || choice.refusal;
    if (typeof refusal === "string" && refusal.trim()) {
      const err = new Error(
        sanitizeErrorMessage(`Meta model refused to generate completion: ${refusal.trim()}`)
      );
      (err as unknown as { status: number; statusCode: number }).status = 502;
      (err as unknown as { status: number; statusCode: number }).statusCode = 502;
      throw err;
    }
  }

  // Extract text from choice or top-level fields
  let extractedText: string | undefined;
  let isNullContent = false;

  if (choice) {
    const messageObj =
      choice.message && typeof choice.message === "object"
        ? (choice.message as Record<string, unknown>)
        : undefined;

    if (messageObj && "content" in messageObj) {
      const content = messageObj.content;
      if (typeof content === "string") {
        extractedText = content;
      } else if (content === null) {
        isNullContent = true;
      } else if (Array.isArray(content)) {
        // Multi-part content parts: [{ type: "text", text: "..." }]
        const partsText = content
          .map((part) => {
            if (typeof part === "string") return part;
            if (part && typeof part === "object") {
              const partObj = part as Record<string, unknown>;
              if (typeof partObj.text === "string") return partObj.text;
              if (typeof partObj.content === "string") return partObj.content;
            }
            return "";
          })
          .join("");
        if (partsText) {
          extractedText = partsText;
        }
      } else if (typeof content === "object" && content !== null) {
        const contentObj = content as Record<string, unknown>;
        if (typeof contentObj.text === "string") {
          extractedText = contentObj.text;
        }
      }
    }

    // Fallback: choice.text (legacy completion format)
    if (extractedText === undefined && typeof choice.text === "string") {
      extractedText = choice.text;
    }

    // Fallback: choice.delta?.content
    if (extractedText === undefined && choice.delta && typeof choice.delta === "object") {
      const deltaObj = choice.delta as Record<string, unknown>;
      if (typeof deltaObj.content === "string") {
        extractedText = deltaObj.content;
      }
    }
  }

  // Fallback to top-level fields
  if (extractedText === undefined) {
    if (typeof payload.output_text === "string") {
      extractedText = payload.output_text;
    } else if (typeof payload.response === "string") {
      extractedText = payload.response;
    } else if (typeof payload.generated_text === "string") {
      extractedText = payload.generated_text;
    } else if (typeof payload.text === "string") {
      extractedText = payload.text;
    }
  }

  const finishReason =
    (choice && typeof choice.finish_reason === "string" ? choice.finish_reason : undefined) ||
    (typeof payload.finish_reason === "string" ? payload.finish_reason : undefined);

  // Check for content filter / safety block
  if (
    finishReason &&
    (finishReason.toLowerCase() === "content_filter" || finishReason.toLowerCase() === "safety") &&
    (!extractedText || !extractedText.trim())
  ) {
    const err = new Error(
      `Meta generation was filtered by safety policies (finish_reason: ${finishReason}).`
    );
    (err as unknown as { status: number; statusCode: number }).status = 502;
    (err as unknown as { status: number; statusCode: number }).statusCode = 502;
    throw err;
  }

  // Validate extracted text
  if (!choices && extractedText === undefined) {
    const err = new Error("Meta API response missing 'choices' array and alternative text fields.");
    (err as unknown as { status: number; statusCode: number }).status = 502;
    (err as unknown as { status: number; statusCode: number }).statusCode = 502;
    throw err;
  }

  if (isNullContent && extractedText === undefined) {
    const err = new Error("Meta returned null completion content.");
    (err as unknown as { status: number; statusCode: number }).status = 502;
    (err as unknown as { status: number; statusCode: number }).statusCode = 502;
    throw err;
  }

  if (extractedText === undefined) {
    const err = new Error("Meta returned a completion without text content.");
    (err as unknown as { status: number; statusCode: number }).status = 502;
    (err as unknown as { status: number; statusCode: number }).statusCode = 502;
    throw err;
  }

  if (!extractedText.trim()) {
    const err = new Error("Meta returned an empty completion string.");
    (err as unknown as { status: number; statusCode: number }).status = 502;
    (err as unknown as { status: number; statusCode: number }).statusCode = 502;
    throw err;
  }

  const truncated =
    typeof finishReason === "string" &&
    (finishReason.trim().toLowerCase() === "length" ||
      finishReason.trim().toLowerCase() === "max_tokens");

  const rawUsage =
    payload.usage && typeof payload.usage === "object"
      ? (() => {
          const u = payload.usage as Record<string, unknown>;
          return {
            promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
            completionTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
            totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : undefined,
          };
        })()
      : undefined;

  return {
    outputText: extractedText,
    finishReason,
    truncated,
    rawUsage,
  };
}

export class MetaProvider implements ModelProvider {
  name: ModelProviderType = "meta";
  private config?: MetaProviderConfig;

  constructor(config?: MetaProviderConfig) {
    this.config = config;
  }

  public getResolvedEndpoint(): {
    endpoint: string;
    baseUrl: string;
    apiKey: string | undefined;
  } {
    const explicitKey = (this.config?.apiKey || process.env.MODEL_API_KEY || "").trim();
    const explicitBaseUrl = (this.config?.baseUrl || process.env.META_BASE_URL || process.env.MODEL_BASE_URL || "").trim();
    const baseUrl = (explicitBaseUrl || "https://api.meta.ai/v1").replace(/\/+$/, "");

    return {
      endpoint: `${baseUrl}/chat/completions`,
      baseUrl,
      apiKey: explicitKey || undefined,
    };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const { endpoint, apiKey } = this.getResolvedEndpoint();

    if (!apiKey) {
      throw new Error("MODEL_API_KEY is not configured.");
    }

    const model = request.model || "muse-spark-1.3";
    const fetchFunc = this.config?.fetchFn || fetch;

    const bodyPayload: Record<string, unknown> = {
      model,
      messages: [
        {
          role: "user",
          content: request.input,
        },
      ],
      temperature: request.generationConfig?.temperature ?? 0.2,
      max_tokens: request.generationConfig?.maxOutputTokens ?? 8192,
    };

    if (request.responseFormat?.mime_type === "application/json") {
      bodyPayload.response_format = { type: "json_object" };
    }

    const timeoutMs = request.timeoutMs ?? resolveProviderTimeoutMs();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new Error(`Meta API request timed out after ${Math.round(timeoutMs / 1000)}s`)
      );
    }, timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetchFunc(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(bodyPayload),
          signal: controller.signal,
        });
      } catch (networkError) {
        const isTimeout =
          timedOut ||
          (networkError instanceof Error &&
            (networkError.name === "TimeoutError" ||
              networkError.name === "AbortError" ||
              /timeout/i.test(networkError.message)));

        if (isTimeout) {
          const timeoutErr = new Error(
            sanitizeErrorMessage(
              `Meta API request timed out after ${Math.round(
                timeoutMs / 1000
              )}s. Upstream model took too long to complete.`
            )
          );
          (timeoutErr as unknown as { status: number; statusCode: number }).status = 504;
          (timeoutErr as unknown as { status: number; statusCode: number }).statusCode = 504;
          throw timeoutErr;
        }

        const baseMsg =
          networkError instanceof Error ? networkError.message : "Unknown network error";
        const netErr = new Error(sanitizeErrorMessage(`Meta API network request failed: ${baseMsg}`));
        (netErr as unknown as { status: number; statusCode: number }).status = 503;
        (netErr as unknown as { status: number; statusCode: number }).statusCode = 503;
        throw netErr;
      }

      if (!response.ok) {
        let errorBody = "";
        try {
          errorBody = await response.text();
        } catch (textErr) {
          const isTimeout =
            timedOut ||
            (textErr instanceof Error &&
              (textErr.name === "TimeoutError" ||
                textErr.name === "AbortError" ||
                /timeout/i.test(textErr.message)));
          if (isTimeout) {
            const timeoutErr = new Error(
              sanitizeErrorMessage(
                `Meta API request timed out after ${Math.round(
                  timeoutMs / 1000
                )}s while reading error response.`
              )
            );
            (timeoutErr as unknown as { status: number; statusCode: number }).status = 504;
            (timeoutErr as unknown as { status: number; statusCode: number }).statusCode = 504;
            throw timeoutErr;
          }
          errorBody = "";
        }

        if (response.status === 401) {
          const authErr = new Error("Meta API authentication failed (401). Please check MODEL_API_KEY.");
          (authErr as unknown as { status: number; statusCode: number }).status = 401;
          (authErr as unknown as { status: number; statusCode: number }).statusCode = 401;
          throw authErr;
        }
        if (response.status === 429) {
          const rateErr = new Error("Meta API rate limit exceeded (429). Please try again later.");
          (rateErr as unknown as { status: number; statusCode: number }).status = 429;
          (rateErr as unknown as { status: number; statusCode: number }).statusCode = 429;
          throw rateErr;
        }
        const statusText = response.statusText ? ` ${response.statusText}` : "";
        const detailMsg = errorBody ? ` Details: ${errorBody}` : "";
        const upstreamErr = new Error(
          sanitizeErrorMessage(
            `Meta API error (${response.status}):${statusText || " Upstream service failure"}${detailMsg}`
          )
        );
        (upstreamErr as unknown as { status: number; statusCode: number }).status = response.status;
        (upstreamErr as unknown as { status: number; statusCode: number }).statusCode = response.status;
        throw upstreamErr;
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch (jsonErr) {
        const isTimeout =
          timedOut ||
          (jsonErr instanceof Error &&
            (jsonErr.name === "TimeoutError" ||
              jsonErr.name === "AbortError" ||
              /timeout/i.test(jsonErr.message)));
        if (isTimeout) {
          const timeoutErr = new Error(
            sanitizeErrorMessage(
              `Meta API request timed out after ${Math.round(
                timeoutMs / 1000
              )}s while reading response body.`
            )
          );
          (timeoutErr as unknown as { status: number; statusCode: number }).status = 504;
          (timeoutErr as unknown as { status: number; statusCode: number }).statusCode = 504;
          throw timeoutErr;
        }
        const parseErr = new Error("Failed to parse JSON response from Meta API.");
        (parseErr as unknown as { status: number; statusCode: number }).status = 502;
        (parseErr as unknown as { status: number; statusCode: number }).statusCode = 502;
        throw parseErr;
      }

      const extracted = extractTextFromMetaResponse(data);

      return {
        outputText: extracted.outputText,
        finishReason: extracted.finishReason,
        truncated: extracted.truncated,
        rawUsage: extracted.rawUsage,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class ModelRouter {
  private providers: Map<ModelProviderType, ModelProvider> = new Map();
  private defaultProvider: ModelProviderType;

  constructor(defaultProvider?: ModelProviderType) {
    this.defaultProvider = defaultProvider || "meta";
    this.registerProvider(new MetaProvider());
  }

  public registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.name, provider);
  }

  public getProvider(name: ModelProviderType): ModelProvider | undefined {
    return this.providers.get(name);
  }

  public hasProvider(name: ModelProviderType): boolean {
    return this.providers.has(name);
  }

  public async generate(
    request: ModelRequest,
    providerType?: ModelProviderType
  ): Promise<ModelResponse> {
    const targetProvider = providerType || this.defaultProvider;

    const providerConfig = AVAILABLE_PROVIDERS.find(
      (p) => p.provider === targetProvider
    );

    if (!providerConfig) {
      throw new Error(
        `Selected provider '${targetProvider}' is not available or registered.`
      );
    }

    const provider = this.providers.get(targetProvider);

    if (!provider) {
      throw new Error(
        `Selected provider '${targetProvider}' is not registered in ModelRouter.`
      );
    }

    if (request.model) {
      const validModel = providerConfig.models.some(
        (m) => m.id === request.model
      );
      if (!validModel) {
        throw new Error(
          `Selected model '${request.model}' is not valid or available for provider '${targetProvider}'.`
        );
      }
    }

    return provider.generate(request);
  }

  public async generateWithFallback(
    request: ModelRequest,
    requestedProvider?: ModelProviderType
  ): Promise<GenerateWithFallbackResult> {
    const primaryProvider = requestedProvider || this.defaultProvider;
    const providerConfig = AVAILABLE_PROVIDERS.find(
      (p) => p.provider === primaryProvider
    );

    const primaryModel =
      request.model ||
      providerConfig?.models.find((m) => m.isDefault)?.id ||
      providerConfig?.models[0]?.id ||
      "muse-spark-1.3";

    if (providerConfig) {
      const validModel = providerConfig.models.some((m) => m.id === primaryModel);
      if (!validModel) {
        throw new Error(
          `Selected model '${primaryModel}' is not valid or available for provider '${primaryProvider}'.`
        );
      }
    }

    // Direct generation through MetaProvider with zero cross-provider fallback
    const response = await this.generate(
      {
        ...request,
        model: primaryModel,
      },
      primaryProvider
    );

    return {
      response,
      usedModel: primaryModel,
      usedProvider: primaryProvider,
      primaryModel,
      primaryProvider,
      fallbackUsed: false,
      attemptedModels: [{ provider: primaryProvider, model: primaryModel }],
    };
  }
}

export const modelRouter = new ModelRouter();

export function sanitizeErrorMessage(message: string): string {
  if (!message || typeof message !== "string") return "An unexpected error occurred.";

  let sanitized = message;

  const configuredKey = process.env.MODEL_API_KEY?.trim();
  if (configuredKey && configuredKey.length > 0) {
    sanitized = sanitized.split(configuredKey).join("[REDACTED]");
  }

  return sanitized
    .replace(/meta[-_][A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(/nvapi-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/nebius[-_][A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(/AIza[0-9A-Za-z-_]{30,}/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/([?&]key=)[^&]+/gi, "$1[REDACTED]");
}

export function getErrorStatusCode(error: unknown): number {
  if (!error) return 500;

  const message = error instanceof Error ? error.message : String(error);
  const lowerMsg = message.toLowerCase();

  if (lowerMsg.includes("is not configured")) {
    return 500;
  }

  if (typeof error === "object" && error !== null) {
    const status =
      (error as { status?: number; statusCode?: number }).status ||
      (error as { status?: number; statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status <= 599) {
      return status;
    }
  }

  if (
    lowerMsg.includes("authentication failed") ||
    lowerMsg.includes("unauthorized") ||
    lowerMsg.includes("invalid api key") ||
    lowerMsg.includes("401")
  ) {
    return 401;
  }

  if (lowerMsg.includes("403") || lowerMsg.includes("forbidden")) {
    return 403;
  }

  if (
    lowerMsg.includes("rate limit") ||
    lowerMsg.includes("429") ||
    lowerMsg.includes("resource_exhausted") ||
    lowerMsg.includes("quota")
  ) {
    return 429;
  }

  if (
    lowerMsg.includes("504") ||
    lowerMsg.includes("gateway timeout") ||
    lowerMsg.includes("timed out") ||
    lowerMsg.includes("timeout") ||
    lowerMsg.includes("maximum allowed duration") ||
    lowerMsg.includes("took too long to complete")
  ) {
    return 504;
  }

  // Client errors (400 Bad Request)
  if (
    lowerMsg.includes("invalid model") ||
    lowerMsg.includes("not available or registered") ||
    lowerMsg.includes("is not valid or available") ||
    lowerMsg.includes("not valid or available") ||
    lowerMsg.includes("is not registered") ||
    lowerMsg.includes("please provide") ||
    lowerMsg.includes("bad request") ||
    lowerMsg.includes("invalid json request body") ||
    lowerMsg.includes("exceeds maximum allowed length")
  ) {
    return 400;
  }

  // Upstream model/provider generation failures (502 Bad Gateway)
  if (
    lowerMsg.includes("502") ||
    lowerMsg.includes("bad gateway") ||
    lowerMsg.includes("empty completion") ||
    lowerMsg.includes("null completion") ||
    lowerMsg.includes("refused to generate") ||
    lowerMsg.includes("refusal") ||
    lowerMsg.includes("filtered by safety") ||
    lowerMsg.includes("content_filter") ||
    lowerMsg.includes("missing 'choices' array") ||
    lowerMsg.includes("unexpected meta api response structure") ||
    lowerMsg.includes("truncated due to") ||
    lowerMsg.includes("output token limits") ||
    lowerMsg.includes("token limits") ||
    lowerMsg.includes("unterminated string in json") ||
    lowerMsg.includes("failed to parse json") ||
    lowerMsg.includes("malformed json") ||
    lowerMsg.includes("did not return valid json") ||
    lowerMsg.includes("did not return a valid") ||
    lowerMsg.includes("no valid files") ||
    lowerMsg.includes("empty project") ||
    lowerMsg.includes("generated invalid typescript") ||
    lowerMsg.includes("syntactically invalid") ||
    lowerMsg.includes("failed to generate a valid")
  ) {
    return 502;
  }

  if (
    lowerMsg.includes("503") ||
    lowerMsg.includes("service unavailable") ||
    lowerMsg.includes("temporarily unavailable") ||
    lowerMsg.includes("network")
  ) {
    return 503;
  }

  if (lowerMsg.includes("500") || lowerMsg.includes("internal server error")) {
    return 500;
  }

  return 500;
}

export const DEFAULT_IMPROVE_INSTRUCTION =
  "Improve the application's UI/UX, responsiveness, accessibility, and code quality while preserving its existing functionality and overall purpose. Make only useful, targeted changes.";

export function applyChangedFiles(
  currentFiles: { name: string; code: string }[],
  changedFiles: { path: string; code: string }[]
): { name: string; code: string }[] {
  const newFiles = [...currentFiles];
  for (const changedFile of changedFiles) {
    if (
      !changedFile ||
      typeof changedFile.path !== "string" ||
      !changedFile.path.trim() ||
      typeof changedFile.code !== "string"
    ) {
      continue;
    }
    const cleanPath = changedFile.path.trim();
    let index = newFiles.findIndex((f) => f.name === cleanPath);

    if (index === -1 && newFiles.length === 1) {
      index = 0;
    }

    if (index !== -1) {
      newFiles[index] = { name: newFiles[index].name, code: changedFile.code };
    } else {
      newFiles.push({ name: cleanPath, code: changedFile.code });
    }
  }
  return newFiles;
}

export function mergeDependencies(
  currentDeps: Record<string, string>,
  newDeps: Record<string, string>
): Record<string, string> {
  const safeDeps =
    newDeps && typeof newDeps === "object" && !Array.isArray(newDeps)
      ? newDeps
      : {};
  return { ...currentDeps, ...safeDeps };
}
