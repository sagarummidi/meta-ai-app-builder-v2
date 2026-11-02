import { handleAgentRequest } from "@/lib/agent/agentHandler";

export async function POST(request: Request, context?: unknown) {
  return handleAgentRequest(request, context as Parameters<typeof handleAgentRequest>[1]);
}
