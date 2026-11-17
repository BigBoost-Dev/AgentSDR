import "server-only";

import { getPlatformCredentials } from "@/lib/platform/credentials";
import { getPromptTemplate } from "@/lib/observability/langfuse";
import { traceGeneration } from "@/lib/observability/langfuse";
import { fillPrompt } from "@/lib/prompts/template";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import { AGENT_OUTCOMES } from "../contract";
import { agentInstructions, resolveLiveSetupTemplates } from "../liveAgent";
import type { Rehearsal } from "../rehearsal";
import { CallApiError } from "../sessions";
import {
  DEFAULT_ELEVENLABS_VOICE,
  ELEVENLABS_MODES,
  type ElevenLabsMode,
  type ElevenLabsSessionResponse,
  type ElevenLabsVoice,
} from "./contract";

/**
 * ElevenLabs' phone agent (ElevenLabs Agents) as a second voice engine.
 *
 * Nothing is set up by hand in ElevenLabs: AgentSDR keeps one agent per
 * organization and mode in the connected account — found by name, created
 * when missing and patched to the configuration below once per process —
 * with the call's three tools as client tools. The agent itself carries only
 * a placeholder prompt: every conversation brings the call's real system
 * prompt (agentInstructions, the same text a Gemini call gets), its opening
 * line and the voice as overrides, which the agent is configured to accept.
 *
 * Measured 17 Nov 2026 with Nisha's real prompt and recorded replies: the
 * realtime mode replied a median 0.66 s after the lead's last sound (Gemini
 * Live: 1.2 s over 193 replies), but always in English; the standard mode
 * (Scribe → Gemini 3.5 Flash-Lite → Flash v2.5 voices) switches to Hinglish,
 * at about 1–2.5 s.
 */

const API = "https://api.elevenlabs.io";
const SYNC_TTL_MS = 10 * 60 * 1000;
/** Placeholder: each conversation overrides it with the call's own system prompt. */
const PLACEHOLDER_PROMPT = "You are an AI calling agent. Your instructions for each call arrive when the call starts.";
const STANDARD_LLM = "gemini-3.5-flash-lite";
const TOOL_NAMES = ["record_outcome", "wait_for_them", "end_call"] as const;

type Credentials = { apiKey: string };

async function credentials(): Promise<Credentials> {
  const stored = await getPlatformCredentials("elevenlabs");
  if (!stored?.apiKey) throw new CallApiError(409, "Connect ElevenLabs in Settings → AI provider first");
  return { apiKey: stored.apiKey };
}

async function api<T>(key: Credentials, method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: { "xi-api-key": key.apiKey, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch {
    throw new CallApiError(424, "Could not reach ElevenLabs");
  }
  const text = await response.text();
  if (response.status === 401) throw new CallApiError(424, "ElevenLabs rejected the saved API key");
  if (!response.ok) {
    let reason = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { detail?: { message?: string } | string };
      reason = typeof parsed.detail === "string" ? parsed.detail : (parsed.detail?.message ?? reason);
    } catch {}
    // Not 502: Cloudflare replaces a 502's body, and the page should show ElevenLabs' reason.
    throw new CallApiError(424, `ElevenLabs refused (${response.status}): ${reason}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** The call's tools, as ElevenLabs client tools: the same names and descriptions a Gemini call gets. */
async function toolConfigs() {
  const { templates } = await resolveLiveSetupTemplates();
  return [
    {
      type: "client",
      name: "record_outcome",
      description: fillPrompt(templates["calls/tool-record-outcome"], {}),
      expects_response: true,
      parameters: {
        type: "object",
        properties: {
          outcome: { type: "string", enum: [...AGENT_OUTCOMES], description: fillPrompt(templates["calls/tool-record-outcome-kinds"], {}) },
          summary: { type: "string", description: "One sentence on what happened and anything they asked for." },
          when: { type: "string", description: "For meeting_booked, human_callback or call_back: the day and time as agreed, in their words (\"Thursday around 4 pm\")." },
          whenAt: { type: "string", description: "The exact instant of an agreed meeting or call-back time, ISO 8601 with UTC offset, worked out from the current date and time in your instructions. Omit if no time was agreed." },
        },
        required: ["outcome", "summary"],
      },
    },
    { type: "client", name: "wait_for_them", description: fillPrompt(templates["calls/tool-wait-for-them"], {}), expects_response: true, parameters: { type: "object", properties: {} } },
    {
      type: "client",
      name: "end_call",
      description: fillPrompt(templates["calls/tool-end-call"], {}),
      expects_response: true,
      parameters: { type: "object", properties: { reason: { type: "string", description: "Why the call is ending, in a few words." } } },
    },
  ];
}

/** The account's client tools by name, created when missing. Tools are per account, shared by its agents. */
async function ensureTools(key: Credentials): Promise<string[]> {
  const listed = await api<{ tools?: { id: string; tool_config?: { name?: string; type?: string } }[] }>(key, "GET", "/v1/convai/tools");
  const configs = await toolConfigs();
  const ids: string[] = [];
  for (const name of TOOL_NAMES) {
    const existing = listed.tools?.find((tool) => tool.tool_config?.type === "client" && tool.tool_config?.name === name);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const created = await api<{ id: string }>(key, "POST", "/v1/convai/tools", { tool_config: configs.find((config) => config.name === name) });
    ids.push(created.id);
  }
  return ids;
}

function agentName(mode: ElevenLabsMode): string {
  return `AgentSDR · ${mode === "realtime" ? "Realtime" : "Standard"} · ${currentOrganizationId().slice(0, 8)}`;
}

function agentConfig(mode: ElevenLabsMode, toolIds: string[]) {
  // Hindi only where it can be spoken: the realtime model answered Hindi in
  // English, and with Hindi detection on it heard English as Hindi ("Sure" as
  // "चार") and replied slower (median 1.1 s instead of 0.66 s; 17 Nov 2026).
  const hindi = mode === "standard";
  return {
    name: agentName(mode),
    tags: ["agentsdr"],
    conversation_config: {
      agent: {
        first_message: "",
        language: "en",
        // Standard: Hindi or Hinglish from the lead switches the agent to Hindi (language_detection), spoken as Hinglish.
        hinglish_mode: hindi,
        prompt: {
          prompt: PLACEHOLDER_PROMPT,
          llm: STANDARD_LLM,
          temperature: 0.6,
          tool_ids: toolIds,
          built_in_tools: {
            language_detection: hindi ? { type: "system", name: "language_detection", description: "", params: { system_tool_type: "language_detection" } } : null,
          },
        },
      },
      // An English agent must use an English-only voice model; the Hindi preset brings a multilingual one.
      language_presets: hindi ? { hi: { overrides: { agent: { language: "hi" }, tts: { model_id: "eleven_flash_v2_5" } } } } : {},
      tts: { model_id: "eleven_flash_v2", voice_id: DEFAULT_ELEVENLABS_VOICE, agent_output_audio_format: "pcm_16000" },
      asr: { provider: "scribe_realtime", user_input_audio_format: "pcm_16000", keywords: ["Kandid"] },
      turn: { turn_eagerness: "normal" },
      conversation: {
        max_duration_seconds: 900,
        client_events: ["conversation_initiation_metadata", "audio", "user_transcript", "agent_response", "interruption", "ping", "client_tool_call", "agent_response_correction"],
      },
      realtime_model: mode === "realtime" ? "eleven_realtime_v1_mini" : null,
    },
    platform_settings: {
      overrides: {
        conversation_config_override: {
          agent: { first_message: true, language: true, prompt: { prompt: true } },
          tts: { voice_id: true },
        },
      },
    },
  };
}

const synced = new Map<string, { agentId: string; at: number }>();

/** The organization's agent for `mode`, created or brought up to date (at most every 10 minutes per process). */
export async function ensureElevenLabsAgent(mode: ElevenLabsMode): Promise<string> {
  const key = await credentials();
  const cacheKey = `${currentOrganizationId()}|${mode}`;
  const cached = synced.get(cacheKey);
  if (cached && Date.now() - cached.at < SYNC_TTL_MS) return cached.agentId;
  const name = agentName(mode);
  const toolIds = await ensureTools(key);
  const config = agentConfig(mode, toolIds);
  const found = await api<{ agents?: { agent_id: string; name: string }[] }>(key, "GET", `/v1/convai/agents?search=${encodeURIComponent(name)}&page_size=20`);
  const existing = found.agents?.find((agent) => agent.name === name);
  let agentId: string;
  if (existing) {
    await api(key, "PATCH", `/v1/convai/agents/${existing.agent_id}`, config);
    agentId = existing.agent_id;
  } else {
    agentId = (await api<{ agent_id: string }>(key, "POST", "/v1/convai/agents/create", config)).agent_id;
  }
  synced.set(cacheKey, { agentId, at: Date.now() });
  return agentId;
}

/**
 * A rehearsal conversation: a signed URL for the organization's agent and
 * the overrides that make it this campaign's call — the system prompt a
 * Gemini call would get, the opening line and the voice. The browser sends
 * the overrides as the conversation starts; the API key stays here.
 */
export async function elevenLabsRehearsalSession(rehearsal: Rehearsal, mode: ElevenLabsMode, voiceId: string | null): Promise<ElevenLabsSessionResponse> {
  if (!ELEVENLABS_MODES.includes(mode)) throw new CallApiError(400, "mode must be realtime or standard");
  const key = await credentials();
  const [{ templates, prompts }, firstMessage] = await Promise.all([resolveLiveSetupTemplates(), getPromptTemplate("calls/elevenlabs-first-message")]);
  const system = agentInstructions(rehearsal.request, rehearsal.knowledge, rehearsal.context, templates["calls/agent-system"]);
  const firstName = rehearsal.request.lead?.firstName?.trim() ?? "";
  const voice = voiceId?.trim() || DEFAULT_ELEVENLABS_VOICE;
  return traceGeneration(
    {
      name: "call-voice-rehearsal-setup",
      model: `elevenlabs-${mode}`,
      input: { system, voice, mode },
      prompts: [...prompts, firstMessage],
      metadata: { engine: "elevenlabs", knowledge: rehearsal.knowledge.map((document) => document.title) },
    },
    async (record) => {
      const agentId = await ensureElevenLabsAgent(mode);
      const { signed_url: signedUrl } = await api<{ signed_url: string }>(key, "GET", `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
      record({ output: { agentId } });
      return {
        signedUrl,
        mode,
        voiceId: voice,
        override: {
          agent: {
            prompt: { prompt: system },
            first_message: firstName ? fillPrompt(firstMessage.text, { first_name: firstName }) : "",
            language: "en",
          },
          tts: { voice_id: voice },
        },
      };
    },
  );
}

type SharedVoice = { voice_id: string; name: string; gender?: string; age?: string; descriptive?: string; preview_url?: string; language?: string };
const voiceCache = new Map<string, { at: number; voices: ElevenLabsVoice[] }>();

/** Indian-English conversational voices from ElevenLabs' library, most used first; cached an hour. */
export async function listElevenLabsVoices(): Promise<ElevenLabsVoice[]> {
  const key = await credentials();
  const cacheKey = currentOrganizationId();
  const cached = voiceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.voices;
  const query = new URLSearchParams({ accent: "indian", language: "en", use_cases: "conversational", page_size: "24", sort: "usage_character_count_1y" });
  const body = await api<{ voices?: SharedVoice[] }>(key, "GET", `/v1/shared-voices?${query}`);
  const voices = (body.voices ?? []).map((voice) => ({
    id: voice.voice_id,
    name: voice.name,
    detail: [voice.gender, voice.age?.replace("_", " "), voice.descriptive].filter(Boolean).join(" · "),
    previewUrl: voice.preview_url ?? null,
  }));
  voiceCache.set(cacheKey, { at: Date.now(), voices });
  return voices;
}
