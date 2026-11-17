import type { NextRequest } from "next/server";
import { withOrgContext } from "@/lib/auth/context";
import { elevenLabsRehearsalSession } from "@/lib/calls/elevenlabs/agent.server";
import type { ElevenLabsMode } from "@/lib/calls/elevenlabs/contract";
import { resolveRehearsal } from "@/lib/calls/rehearsal";
import { CallApiError, callApiErrorResponse } from "@/lib/calls/sessions";

/**
 * POST /api/calling/agent/rehearse/elevenlabs — the same rehearsal as
 * …/rehearse/voice (same body: campaignId, contactId, stepId, …), held with
 * ElevenLabs' phone agent instead of Gemini: a signed conversation URL and
 * the overrides that make it this campaign's call, plus `mode` (realtime or
 * standard) and `voiceId`. Nothing is placed or saved.
 */
export async function POST(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") throw new CallApiError(400, "Expected a JSON object");
      const mode = (body.mode === "standard" ? "standard" : "realtime") as ElevenLabsMode;
      const voiceId = typeof body.voiceId === "string" && /^[A-Za-z0-9]{10,40}$/.test(body.voiceId) ? body.voiceId : null;
      const { mode: _mode, voiceId: _voice, ...rest } = body;
      return Response.json(await elevenLabsRehearsalSession(await resolveRehearsal(rest), mode, voiceId));
    });
  } catch (error) {
    return callApiErrorResponse(error);
  }
}
