import { NextResponse } from "next/server";
import { getErrorStatusCode, sanitizeErrorMessage } from "@/lib/modelRouter";
import { handleAgentRequest } from "@/lib/agent/agentHandler";

export const maxDuration = 600;
export const dynamic = "force-dynamic";

export async function POST(request: Request, context?: unknown) {
  try {
    return await handleAgentRequest(
      request,
      context as Parameters<typeof handleAgentRequest>[1]
    );
  } catch (error) {
    const status = getErrorStatusCode(error);
    const message = sanitizeErrorMessage(
      error instanceof Error ? error.message : "An unexpected repair error occurred."
    );
    console.error("[API /agent] Unhandled route error:", message);
    return NextResponse.json({ success: false, message }, { status });
  }
}
