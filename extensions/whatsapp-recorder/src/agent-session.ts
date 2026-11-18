/**
 * One AI agent for a call, Gemini Live (LiveAgent) or ElevenLabs
 * (ElevenAgent): which one is only known once AgentSDR answers the token
 * request — the call's campaign chooses its voice engine. wa-agent drives
 * this the same way either way; what it asks before the engine is known
 * (prepare the greeting, the pick-up) is passed on once it is.
 */
import type { ElevenLabsCallSession } from "../../../src/lib/calls/contract";
import { ElevenAgent } from "./eleven-agent";
import { LiveAgent, type AgentHandlers } from "./live-agent";
import type { AgentTokenResult } from "./messages";

type Engine = LiveAgent | ElevenAgent;

export class AgentSession {
  private engine: Engine | null = null;
  private closed = false;
  private wantsGreeting = false;
  private pickedUp = false;

  constructor(private readonly handlers: AgentHandlers) {}

  async start(): Promise<void> {
    this.handlers.trace("AI agent: asking for a session");
    const result = await this.handlers.token();
    if (this.closed) return;
    if (!result.ok) {
      this.handlers.trace(`AI agent: no session — ${result.error}`);
      return;
    }
    if (result.elevenlabs) {
      const engine = new ElevenAgent(this.handlers, result as typeof result & { elevenlabs: ElevenLabsCallSession });
      this.engine = engine;
      engine.start();
    } else {
      // LiveAgent asks for its token itself: hand it the one already here.
      const cached: AgentTokenResult = result;
      const engine = new LiveAgent({ ...this.handlers, token: async () => cached,
        trace: (step) => {
          if (step !== "AI agent: asking for a session") this.handlers.trace(step);
        },
      });
      this.engine = engine;
      if (this.wantsGreeting) engine.prepareGreeting();
      await engine.start();
    }
    if (this.wantsGreeting) this.engine?.prepareGreeting();
    if (this.pickedUp) this.engine?.greet();
  }

  prepareGreeting(): void {
    this.wantsGreeting = true;
    this.engine?.prepareGreeting();
  }

  greet(): void {
    this.pickedUp = true;
    this.engine?.greet();
  }

  /** Waits for the engine, then for its greeting (see LiveAgent / ElevenAgent). */
  async greetingHeld(maxMs: number): Promise<boolean> {
    const until = Date.now() + maxMs;
    while (!this.engine && !this.closed && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!this.engine) return false;
    return this.engine.greetingHeld(Math.max(0, until - Date.now()));
  }

  sendAudio(pcm: ArrayBuffer): void {
    if (this.engine) this.engine.sendAudio(pcm);
  }

  takeHeardAudio(): Int16Array | null {
    return this.engine?.takeHeardAudio() ?? null;
  }

  close(): void {
    this.closed = true;
    this.engine?.close();
  }
}
