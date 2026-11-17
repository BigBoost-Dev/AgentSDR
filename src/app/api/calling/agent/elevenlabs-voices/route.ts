import type { NextRequest } from "next/server";
import { withOrgContext } from "@/lib/auth/context";
import { listElevenLabsVoices } from "@/lib/calls/elevenlabs/agent.server";
import { callApiErrorResponse } from "@/lib/calls/sessions";

/** GET /api/calling/agent/elevenlabs-voices — Indian-English voices from ElevenLabs' library, for the Compare voices picker. */
export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => Response.json({ voices: await listElevenLabsVoices() }));
  } catch (error) {
    return callApiErrorResponse(error);
  }
}
