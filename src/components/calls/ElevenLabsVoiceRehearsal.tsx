"use client";

import { useEffect, useRef, useState } from "react";
import { RiLoader4Line, RiMicLine, RiPhoneFill, RiPhoneLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import type { ElevenLabsMode, ElevenLabsSessionResponse } from "@/lib/calls/elevenlabs/contract";
import { createDownsampler } from "../../../extensions/whatsapp-recorder/src/downsample";
import { toolLabel, type Tool } from "./AgentRehearsal";
import { ReplyGaps } from "./AgentVoiceRehearsal";
import { fromBase64, recordConversation, TAP_WORKLET, toBase64, VOICE_PEAK, type ConversationRecording } from "./rehearsalAudio";

type Line = { who: "lead" | "agent"; text: string } | { who: "tool"; tool: Tool };
type Phase = "idle" | "connecting" | "live" | "ended";

/** The mic is sent in ~40 ms blocks, as the extension sends a call's audio. */
const BLOCK_SECONDS = 0.04;
const RATE = 16_000;

type ServerEvent =
  | { type: "conversation_initiation_metadata" }
  | { type: "audio"; audio_event: { audio_base_64: string } }
  | { type: "user_transcript"; user_transcription_event: { user_transcript: string } }
  | { type: "agent_response"; agent_response_event: { agent_response: string } }
  | { type: "agent_response_correction"; agent_response_correction_event: { corrected_agent_response: string } }
  | { type: "interruption" }
  | { type: "ping"; ping_event: { event_id: number } }
  | { type: "client_tool_call"; client_tool_call: { tool_name: string; tool_call_id: string; parameters?: Record<string, unknown> } };

/**
 * The voice rehearsal of AgentVoiceRehearsal, held with ElevenLabs' phone
 * agent instead of Gemini: the same campaign session (POST
 * /api/calling/agent/rehearse/elevenlabs builds the call's own system prompt
 * and opening line), heard and spoken by ElevenLabs. Replies are timed the
 * way LiveAgent times Gemini's: from the last mic block above -40 dBFS to
 * the agent's first audio. Nothing is placed or saved.
 */
export function ElevenLabsVoiceRehearsal({ campaignId, contactId, mode, voiceId }: {
  campaignId: string;
  contactId?: string;
  mode: ElevenLabsMode;
  voiceId?: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [gaps, setGaps] = useState<number[]>([]);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => stopRef.current?.(), []);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines]);
  useEffect(() => {
    if (phase !== "live") return;
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, [phase]);

  async function start() {
    setError(null);
    setLines([]);
    setSeconds(0);
    setGaps([]);
    setRecordingUrl(null);
    setPhase("connecting");

    const context = new AudioContext();
    let microphone: MediaStream;
    try {
      microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      void context.close();
      setPhase("idle");
      setError("Allow the microphone to rehearse by voice.");
      return;
    }

    let ended = false;
    let socket: WebSocket | null = null;
    let tap: AudioWorkletNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let recording: ConversationRecording | null = null;
    let playHead = 0;
    let hangupTimer = 0;
    const playing = new Set<AudioBufferSourceNode>();
    // Reply timing: the lead's last sound, and whether the agent has spoken since.
    let lastVoiceAt = 0;
    let replying = false;

    const stop = (why?: string) => {
      if (ended) return;
      ended = true;
      window.clearTimeout(hangupTimer);
      try {
        socket?.close();
      } catch {}
      if (recording) void recording.stop().then((url) => url && setRecordingUrl(url));
      tap?.port.close();
      tap?.disconnect();
      source?.disconnect();
      for (const node of playing) node.stop();
      microphone.getTracks().forEach((track) => track.stop());
      void context.close();
      stopRef.current = null;
      setPhase("ended");
      if (why) setError(why);
    };
    stopRef.current = () => stop();

    const send = (message: unknown) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };

    const play = (samples: Int16Array) => {
      const buffer = context.createBuffer(1, samples.length, RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) channel[i] = samples[i]! / 0x8000;
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      if (recording) node.connect(recording.input);
      const at = Math.max(context.currentTime + 0.02, playHead);
      node.start(at);
      playHead = at + buffer.duration;
      playing.add(node);
      node.onended = () => playing.delete(node);
    };

    let session: ElevenLabsSessionResponse;
    try {
      const response = await fetch("/api/calling/agent/rehearse/elevenlabs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, contactId, mode, voiceId }),
      });
      const body = (await response.json().catch(() => null)) as (ElevenLabsSessionResponse & { error?: string }) | null;
      if (!response.ok || !body?.signedUrl) throw new Error(body?.error ?? `HTTP ${response.status}`);
      session = body;
    } catch (caught) {
      stop();
      setError(`Could not start the agent: ${caught instanceof Error ? caught.message : String(caught)}`);
      return;
    }
    if (ended) return;

    try {
      await context.audioWorklet.addModule(URL.createObjectURL(new Blob([TAP_WORKLET], { type: "application/javascript" })));
      source = context.createMediaStreamSource(microphone);
      recording = recordConversation(context, source);
      tap = new AudioWorkletNode(context, "agentsdr-tap");
    } catch (caught) {
      stop();
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }

    socket = new WebSocket(session.signedUrl);
    socket.onopen = () => send({ type: "conversation_initiation_client_data", conversation_config_override: session.override });
    socket.onclose = (event) => {
      if (ended) return;
      const remaining = Math.max(0, playHead - context.currentTime) * 1000;
      hangupTimer = window.setTimeout(() => stop(event.code === 1000 ? undefined : `ElevenLabs closed the call (${event.code}${event.reason ? `: ${event.reason}` : ""}).`), remaining + 300);
    };
    socket.onerror = () => {
      if (!ended) setError("Lost the connection to ElevenLabs.");
    };
    socket.onmessage = (event) => {
      if (ended) return;
      let message: ServerEvent;
      try {
        message = JSON.parse(String(event.data)) as ServerEvent;
      } catch {
        return;
      }
      switch (message.type) {
        case "conversation_initiation_metadata": {
          setPhase("live");
          const downsample = createDownsampler(context.sampleRate, RATE);
          const blockSize = Math.round(context.sampleRate * BLOCK_SECONDS);
          let pending = new Float32Array(0);
          tap!.port.onmessage = (tapped: MessageEvent<Float32Array>) => {
            if (ended) return;
            const joined = new Float32Array(pending.length + tapped.data.length);
            joined.set(pending);
            joined.set(tapped.data, pending.length);
            pending = joined;
            while (pending.length >= blockSize) {
              const pcm = downsample(pending.subarray(0, blockSize));
              pending = pending.slice(blockSize);
              if (!pcm.length) continue;
              let peak = 0;
              for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
              if (peak > VOICE_PEAK) {
                lastVoiceAt = Date.now();
                replying = false;
              }
              send({ user_audio_chunk: toBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)) });
            }
          };
          source!.connect(tap!);
          break;
        }
        case "audio": {
          if (!replying && lastVoiceAt) {
            const gap = Date.now() - lastVoiceAt;
            setGaps((current) => [...current, gap]);
          }
          replying = true;
          play(fromBase64(message.audio_event.audio_base_64));
          break;
        }
        case "interruption":
          for (const node of playing) node.stop();
          playing.clear();
          playHead = context.currentTime;
          break;
        case "user_transcript": {
          const text = message.user_transcription_event.user_transcript.trim();
          if (text) setLines((current) => [...current, { who: "lead", text }]);
          break;
        }
        case "agent_response": {
          const text = message.agent_response_event.agent_response.trim();
          if (text) setLines((current) => [...current, { who: "agent", text }]);
          break;
        }
        case "agent_response_correction": {
          // Cut off mid-sentence: ElevenLabs reports what was actually said.
          const text = message.agent_response_correction_event.corrected_agent_response.trim();
          setLines((current) => {
            const index = current.map((line) => line.who).lastIndexOf("agent");
            if (index < 0) return current;
            const next = [...current];
            next[index] = { who: "agent", text: `${text} —` };
            return next;
          });
          break;
        }
        case "ping":
          send({ type: "pong", event_id: message.ping_event.event_id });
          break;
        case "client_tool_call": {
          const call = message.client_tool_call;
          setLines((current) => [...current, { who: "tool", tool: { name: call.tool_name, args: call.parameters ?? {} } }]);
          send({ type: "client_tool_result", tool_call_id: call.tool_call_id, result: JSON.stringify({ ok: true }), is_error: false });
          if (call.tool_name === "end_call") {
            // As on a call: let the goodbye finish, then hang up.
            window.clearTimeout(hangupTimer);
            hangupTimer = window.setTimeout(() => stop(), Math.max(0, playHead - context.currentTime) * 1000 + 1500);
          }
          break;
        }
      }
    };
  }

  const busy = phase === "connecting" || phase === "live";
  const minutes = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-paragraph-xs text-text-sub-600">Use headphones, so it does not hear itself. No call is placed.</p>
        {busy ? (
          <Button.Root variant="error" mode="filled" size="xsmall" onClick={() => stopRef.current?.()}>
            <Button.Icon as={RiPhoneFill} className="rotate-[135deg]" />
            Hang up
          </Button.Root>
        ) : (
          <Button.Root variant="primary" mode="filled" size="xsmall" onClick={() => void start()}>
            <Button.Icon as={RiPhoneLine} />
            {phase === "ended" ? "Call again" : "Start rehearsal call"}
          </Button.Root>
        )}
      </div>

      {phase !== "idle" && (
        <div className="flex items-center gap-2 text-paragraph-xs text-text-sub-600">
          {phase === "connecting" ? <RiLoader4Line className="size-4 animate-spin" aria-hidden /> : phase === "live" ? <RiMicLine className="size-4 text-success-base" aria-hidden /> : null}
          <span>
            {phase === "connecting" && "Setting up the ElevenLabs agent…"}
            {phase === "live" && `On the call · ${minutes}`}
            {phase === "ended" && `Call ended · ${minutes}`}
          </span>
        </div>
      )}

      {lines.length > 0 && (
        <div ref={scroller} className="flex max-h-80 flex-col gap-2 overflow-y-auto">
          {lines.map((line, index) =>
            line.who === "tool" ? (
              <span key={index} className="self-start rounded-md bg-bg-weak-50 px-2 py-0.5 text-subheading-2xs text-text-sub-600">
                {toolLabel(line.tool)}
              </span>
            ) : (
              <div key={index} className={line.who === "lead" ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={
                    line.who === "lead"
                      ? "max-w-[85%] rounded-xl bg-bg-weak-50 px-3 py-2 text-paragraph-sm text-text-strong-950"
                      : "max-w-[85%] rounded-xl bg-information-lighter px-3 py-2 text-paragraph-sm text-text-strong-950"
                  }
                >
                  {line.text}
                </div>
              </div>
            ),
          )}
        </div>
      )}

      {gaps.length > 0 ? <ReplyGaps gaps={gaps} /> : null}
      {recordingUrl ? <audio controls src={recordingUrl} className="w-full" /> : null}
      {error ? <p className="text-paragraph-xs text-error-base">{error}</p> : null}
    </div>
  );
}
