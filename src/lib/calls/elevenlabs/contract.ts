/**
 * Shapes shared by the ElevenLabs voice engine's routes and the browser
 * (client-safe: no imports). See agent.server.ts.
 */

/** realtime: ElevenLabs runs hearing, thinking and voice (fastest, English only). standard: Scribe → an LLM → a voice, switches to Hinglish. */
export const ELEVENLABS_MODES = ["realtime", "standard"] as const;
export type ElevenLabsMode = (typeof ELEVENLABS_MODES)[number];

/** "Monika Sogam – Natural Conversations", an Indian-English and Hindi voice from ElevenLabs' library. */
export const DEFAULT_ELEVENLABS_VOICE = "EaBs7G1VibMrNAuz2Na7";

export type ElevenLabsVoice = {
  id: string;
  name: string;
  detail: string;
  previewUrl: string | null;
  /** ElevenLabs' accent label ("indian", "american", "british", …), or null. */
  accent: string | null;
};

const ACCENT_FLAGS: Record<string, string> = {
  indian: "🇮🇳",
  american: "🇺🇸",
  british: "🇬🇧",
  australian: "🇦🇺",
  canadian: "🇨🇦",
  irish: "🇮🇪",
  scottish: "🏴",
  "south african": "🇿🇦",
  nigerian: "🇳🇬",
  singaporean: "🇸🇬",
  filipino: "🇵🇭",
  "new zealand": "🇳🇿",
};

/** The flag in front of a voice in the pickers: its accent's country, 🌐 when it has none (Gemini's voices follow the instructions). */
export function accentFlag(accent: string | null | undefined): string {
  return (accent && ACCENT_FLAGS[accent.toLowerCase()]) || "🌐";
}

/** "🇮🇳 Monika Sogam · female · young · casual". */
export function elevenLabsVoiceLabel(voice: ElevenLabsVoice): string {
  return `${accentFlag(voice.accent)} ${voice.name}${voice.detail ? ` · ${voice.detail}` : ""}`;
}

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
