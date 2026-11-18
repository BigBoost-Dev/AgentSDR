import type { NextRequest } from "next/server";
import { readCrmJson } from "@/lib/crm/categories";
import { callVoiceEngine, mintElevenLabsCallToken } from "@/lib/calls/elevenlabs/agent.server";
import { mintAgentToken, parseAgentTokenRequest } from "@/lib/calls/liveAgent";
import { callApiErrorResponse, withRecorderScope } from "@/lib/calls/sessions";

/**
 * The AI voice agent's session for this call: a Gemini Live token, or an
 * ElevenLabs conversation when the call's campaign talks through ElevenLabs
 * (its voice engine). Called by
 * the recorder extension's service worker with the per-call bearer token,
 * like the rest of this prefix (see the started/ route's comment).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withRecorderScope(request, (await params).id, async (row) => {
      const body = parseAgentTokenRequest(await readCrmJson(request));
      const { engine, voice } = await callVoiceEngine(row.campaignContactId);
      return Response.json(engine === "elevenlabs" ? await mintElevenLabsCallToken(row, body, voice) : await mintAgentToken(row, body));
    });
  } catch (error) {
    return callApiErrorResponse(error);
  }
}
