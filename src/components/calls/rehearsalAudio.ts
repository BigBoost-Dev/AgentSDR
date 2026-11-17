/**
 * Browser audio shared by the voice rehearsals (Gemini: AgentVoiceRehearsal,
 * ElevenLabs: ElevenLabsVoiceRehearsal): the microphone tap and a recording
 * of the whole conversation, both sides mixed, for listening back.
 */

/** A worklet that hands the microphone's samples to the page, block by block. */
export const TAP_WORKLET = `
class AgentsdrTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("agentsdr-tap", AgentsdrTap);
`;

/** A lead-side block this loud (-40 dBFS) counts as them making sound: the reply gap's start, as LiveAgent measures it. */
export const VOICE_PEAK = 0x8000 / 100;

export type ConversationRecording = {
  /** Connect the agent's playback nodes here, beside the speakers. */
  input: AudioNode;
  /** Stops recording; resolves to a blob URL of the conversation (null when nothing was recorded). */
  stop(): Promise<string | null>;
};

/** Records the microphone and everything connected to `input`, mixed, until stop(). Call stop() before closing the context. */
export function recordConversation(context: AudioContext, microphone: AudioNode): ConversationRecording | null {
  if (typeof MediaRecorder === "undefined") return null;
  const destination = context.createMediaStreamDestination();
  microphone.connect(destination);
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(destination.stream);
  } catch {
    return null;
  }
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.start(1000);
  return {
    input: destination,
    stop: () =>
      new Promise((resolve) => {
        if (recorder.state === "inactive") return resolve(chunks.length ? URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType })) : null);
        recorder.onstop = () => resolve(chunks.length ? URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType })) : null);
        recorder.stop();
      }),
  };
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Int16Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

/** The median of the reply gaps, or null when there are none. */
export function medianMs(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}
