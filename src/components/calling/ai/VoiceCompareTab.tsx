"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import * as Select from "@/components/alignui/select";
import { AgentVoiceRehearsal } from "@/components/calls/AgentVoiceRehearsal";
import { ElevenLabsVoiceRehearsal } from "@/components/calls/ElevenLabsVoiceRehearsal";
import type { AiCampaignDetail, AiCampaignLead } from "@/lib/calls/aiCampaigns/api";
import { aiApi, listAiLeads } from "@/lib/calls/aiCampaigns/client";
import { DEFAULT_ELEVENLABS_VOICE, type ElevenLabsMode, type ElevenLabsVoice } from "@/lib/calls/elevenlabs/contract";

const MADE_UP = "__made_up";

type VoicesState = { status: "loading" } | { status: "ok"; voices: ElevenLabsVoice[] } | { status: "error"; error: string };

/**
 * Compare voices: the campaign's call rehearsed by voice with Gemini (what
 * calls use today) and with ElevenLabs' phone agent, side by side, as one
 * of its leads or a made-up one. Both get the same session a real call
 * would; each panel times its replies and keeps a recording to listen back
 * to. Nothing is placed or saved.
 */
export function VoiceCompareTab({ campaign }: { campaign: AiCampaignDetail }) {
  const ids = { lead: useId(), mode: useId(), voice: useId() };
  const [leads, setLeads] = useState<AiCampaignLead[]>([]);
  const [contactId, setContactId] = useState<string>(MADE_UP);
  const [mode, setMode] = useState<ElevenLabsMode>("realtime");
  const [voices, setVoices] = useState<VoicesState>({ status: "loading" });
  const [voiceId, setVoiceId] = useState<string>(DEFAULT_ELEVENLABS_VOICE);

  useEffect(() => {
    let live = true;
    listAiLeads(campaign.id, { pageSize: 100 })
      .then((response) => live && setLeads(response.leads))
      .catch(() => {});
    aiApi<{ voices: ElevenLabsVoice[] }>("/api/calling/agent/elevenlabs-voices")
      .then((response) => live && setVoices({ status: "ok", voices: response.voices }))
      .catch((error: unknown) => live && setVoices({ status: "error", error: error instanceof Error ? error.message : "Could not load ElevenLabs voices" }));
    return () => {
      live = false;
    };
  }, [campaign.id]);

  const lead = contactId === MADE_UP ? undefined : contactId;
  const voice = voices.status === "ok" ? voices.voices.find((candidate) => candidate.id === voiceId) : undefined;
  const connected = voices.status !== "error";

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-3xl text-paragraph-sm text-text-sub-600">
        Talk to this campaign&apos;s AI agent with your microphone, once with Gemini (what calls use today) and once with ElevenLabs, as the lead you pick. Both get exactly
        what a real call would: your calling instructions, the campaign&apos;s knowledge and brief, the lead&apos;s history and the time. Each side times how long its replies
        take to start and keeps a recording. Use headphones, and run one side at a time.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-64">
          <label htmlFor={ids.lead} className="mb-1.5 block text-label-sm text-text-strong-950">Play the lead</label>
          <Select.Root size="small" value={contactId} onValueChange={setContactId}>
            <Select.Trigger id={ids.lead}><Select.Value /></Select.Trigger>
            <Select.Content>
              <Select.Item value={MADE_UP}>A made-up lead (Asha Verma, Acme)</Select.Item>
              {leads.map((candidate) => (
                <Select.Item key={candidate.id} value={candidate.id}>
                  {[candidate.name ?? candidate.phone, candidate.companyName].filter(Boolean).join(" · ")}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </div>
        {connected ? (
          <>
            <div className="min-w-56">
              <label htmlFor={ids.mode} className="mb-1.5 block text-label-sm text-text-strong-950">ElevenLabs mode</label>
              <Select.Root size="small" value={mode} onValueChange={(next) => setMode(next as ElevenLabsMode)}>
                <Select.Trigger id={ids.mode}><Select.Value /></Select.Trigger>
                <Select.Content>
                  <Select.Item value="realtime">Realtime: fastest, English only</Select.Item>
                  <Select.Item value="standard">Standard: switches to Hinglish, slower</Select.Item>
                </Select.Content>
              </Select.Root>
            </div>
            <div className="min-w-72">
              <label htmlFor={ids.voice} className="mb-1.5 block text-label-sm text-text-strong-950">ElevenLabs voice</label>
              <Select.Root size="small" value={voiceId} onValueChange={setVoiceId} disabled={voices.status !== "ok"}>
                <Select.Trigger id={ids.voice}><Select.Value placeholder="Loading voices…" /></Select.Trigger>
                <Select.Content>
                  {voices.status === "ok" && !voices.voices.some((candidate) => candidate.id === DEFAULT_ELEVENLABS_VOICE) ? (
                    <Select.Item value={DEFAULT_ELEVENLABS_VOICE}>Monika Sogam (default)</Select.Item>
                  ) : null}
                  {voices.status === "ok"
                    ? voices.voices.map((candidate) => (
                        <Select.Item key={candidate.id} value={candidate.id}>
                          {candidate.name}
                          {candidate.detail ? ` · ${candidate.detail}` : ""}
                        </Select.Item>
                      ))
                    : null}
                </Select.Content>
              </Select.Root>
            </div>
            {voice?.previewUrl ? <audio key={voice.id} controls preload="none" src={voice.previewUrl} className="h-9" aria-label={`Preview of ${voice.name}`} /> : null}
          </>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-2">
          <h3 className="text-label-md text-text-strong-950">Gemini</h3>
          <p className="text-paragraph-xs text-text-sub-600">What calls use today: Gemini Live, voice {campaign.agentVoice ?? "Kore"}.</p>
          <AgentVoiceRehearsal key={`gemini|${contactId}`} campaignId={campaign.id} contactId={lead} compare />
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="text-label-md text-text-strong-950">ElevenLabs</h3>
          {connected ? (
            <>
              <p className="text-paragraph-xs text-text-sub-600">
                {mode === "realtime" ? "Realtime mode" : "Standard mode"}, voice {voice?.name ?? "Monika Sogam"}. AgentSDR sets the agent up in your ElevenLabs account.
              </p>
              <ElevenLabsVoiceRehearsal key={`eleven|${contactId}|${mode}|${voiceId}`} campaignId={campaign.id} contactId={lead} mode={mode} voiceId={voiceId} />
            </>
          ) : (
            <p className="rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-3 text-paragraph-sm text-text-sub-600">
              {voices.status === "error" && !/connect elevenlabs/i.test(voices.error) ? `${voices.error}. ` : ""}
              <Link href="/settings/ai" className="underline">Connect ElevenLabs in Settings → AI provider</Link> to compare it here.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
