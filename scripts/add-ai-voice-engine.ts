/**
 * An AI calling campaign chooses its voice engine: call_campaigns.ai_voice_engine
 * ('gemini', the default: Gemini Live; 'elevenlabs': ElevenLabs' phone agent in
 * its realtime mode) and ai_elevenlabs_voice (an ElevenLabs voice id; null = the
 * default voice). Matches src/lib/calls/schema.ts.
 *
 * Run with:  bun run scripts/add-ai-voice-engine.ts
 *
 * Additive and re-runnable.
 */
import { Client } from "pg";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — check .env.local");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("SET lock_timeout = '5s'");
    await client.query(`ALTER TABLE call_campaigns ADD COLUMN IF NOT EXISTS ai_voice_engine text NOT NULL DEFAULT 'gemini'`);
    await client.query(`ALTER TABLE call_campaigns ADD COLUMN IF NOT EXISTS ai_elevenlabs_voice text`);
    await client.query(`DO $$ BEGIN
      ALTER TABLE call_campaigns ADD CONSTRAINT call_campaigns_ai_voice_engine_check CHECK (ai_voice_engine IN ('gemini', 'elevenlabs'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    console.log("call_campaigns.ai_voice_engine and ai_elevenlabs_voice ready");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
