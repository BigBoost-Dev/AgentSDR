/**
 * Shapes shared by the ElevenLabs voice engine's routes and the browser
 * (client-safe: no imports). See agent.server.ts.
 */

/** realtime: ElevenLabs runs hearing, thinking and voice (fastest, English only). standard: Scribe → an LLM → a voice, switches to Hinglish. */
export const ELEVENLABS_MODES = ["realtime", "standard"] as const;
export type ElevenLabsMode = (typeof ELEVENLABS_MODES)[number];

/** "Monika Sogam – Natural Conversations", an Indian-English and Hindi voice from ElevenLabs' library. */
export const DEFAULT_ELEVENLABS_VOICE = "EaBs7G1VibMrNAuz2Na7";

export type ElevenLabsVoice = { id: string; name: string; detail: string; previewUrl: string | null };

/** What the browser needs to hold one rehearsal conversation with the organization's ElevenLabs agent. */
export type ElevenLabsSessionResponse = {
  /** wss URL, single conversation; the API key never reaches the browser. */
  signedUrl: string;
  mode: ElevenLabsMode;
  voiceId: string;
  /** Sent as conversation_initiation_client_data.conversation_config_override. */
  override: {
    agent: { prompt: { prompt: string }; first_message: string; language: string };
    tts: { voice_id: string };
  };
};
