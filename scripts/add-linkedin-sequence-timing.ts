/**
 * Per-campaign LinkedIn sequence timing and a fourth follow-up.
 *
 * Run with:  bun run scripts/add-linkedin-sequence-timing.ts
 *
 * Three phases, because Postgres will not let all of this share a transaction:
 *
 *  1. "MessageType" gains FOLLOW_UP_4 (ALTER TYPE ... ADD VALUE, autocommit; a
 *     new enum value cannot be used in the transaction that adds it).
 *  2. One transaction adds the columns:
 *       "Campaign": followUp4Message, acceptanceDelayDays (0..30, default 0),
 *         followUp1DelayDays..followUp4DelayDays (1..60, defaults 1 / 2 / 3 / 4)
 *         and the CHECK "Campaign_sequence_delays_chk".
 *       "Lead": followUp4Message, followUp4SentAt, acceptedAt (when the accept was
 *         first handled; the acceptance delay counts from it).
 *     The defaults reproduce the old fixed 24 / 48 / 72 hour gaps and "send the
 *     acceptance message at once", so an untouched campaign behaves as before.
 *  3. The unique index "Message_automated_lead_type_uq" is rebuilt CONCURRENTLY
 *     so its predicate covers FOLLOW_UP_4. It is the delivery claim for every
 *     automated message; without FOLLOW_UP_4 in it a second worker could send
 *     follow-up 4 twice. Build v2, drop the old index, rename v2: the unique
 *     rule is never off. Re-runnable after a crash (a finished v2 is just renamed). Skipped when pg_indexes already shows FOLLOW_UP_4.
 *     The script ends by reading pg_indexes and fails loudly if it is missing.
 *
 * Additive and idempotent: re-running changes nothing. Run it before the code
 * that reads these columns is deployed. Postgres cannot drop an enum value;
 * the extra FOLLOW_UP_4 is harmless if the code is rolled back.
 */
import { Client } from "pg";

const INDEX = "Message_automated_lead_type_uq";
const INDEX_V2 = `${INDEX}_v2`;

// "Lead" first, then "Campaign": the app reads Lead then joins Campaign, so taking the
// locks in that order (each ALTER is brief, lock_timeout 5s) avoids a lock-order deadlock.
const COLUMNS_DDL = `
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "followUp4Message" text;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "followUp4SentAt" timestamp(3);
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "acceptedAt" timestamp(3);
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "followUp4Message" text;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "acceptanceDelayDays" integer NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "followUp1DelayDays" integer NOT NULL DEFAULT 1;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "followUp2DelayDays" integer NOT NULL DEFAULT 2;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "followUp3DelayDays" integer NOT NULL DEFAULT 3;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "followUp4DelayDays" integer NOT NULL DEFAULT 4;
DO $chk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Campaign_sequence_delays_chk' AND conrelid = '"Campaign"'::regclass
  ) THEN
    ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_sequence_delays_chk" CHECK (
      "acceptanceDelayDays" BETWEEN 0 AND 30
      AND "followUp1DelayDays" BETWEEN 1 AND 60
      AND "followUp2DelayDays" BETWEEN 1 AND 60
      AND "followUp3DelayDays" BETWEEN 1 AND 60
      AND "followUp4DelayDays" BETWEEN 1 AND 60
    );
  END IF;
END
$chk$;
`;

const INDEX_PREDICATE = `"leadId" IS NOT NULL AND "duplicateOfMessageId" IS NULL
  AND "type" IN ('INVITATION', 'ACCEPTANCE', 'FOLLOW_UP_1', 'FOLLOW_UP_2', 'FOLLOW_UP_3', 'FOLLOW_UP_4')`;

async function indexDefinition(client: Client, name: string): Promise<string | null> {
  const { rows } = await client.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'Message' AND indexname = $1",
    [name],
  );
  return rows[0]?.indexdef ?? null;
}

async function indexIsValid(client: Client, name: string): Promise<boolean> {
  const { rows } = await client.query<{ indisvalid: boolean }>(
    `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = $1 AND n.nspname = current_schema()`,
    [name],
  );
  return rows[0]?.indisvalid === true;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — check .env.local");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '2min'");

    // Phase 1: the enum value (autocommit).
    await client.query(`ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_4'`);
    console.log(`"MessageType" has FOLLOW_UP_4.`);

    // Phase 2: columns and the CHECK, in one transaction.
    try {
      await client.query("BEGIN");
      await client.query(COLUMNS_DDL);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    console.log(`"Campaign" and "Lead" columns and "Campaign_sequence_delays_chk" are in place.`);

    // Phase 3: make "Message_automated_lead_type_uq" cover FOLLOW_UP_4 (autocommit). Safe to
    // re-run from any point: a run that died after dropping the old index but before renaming
    // the new one leaves a valid, complete _v2, which is simply renamed.
    const current = await indexDefinition(client, INDEX);
    if (current?.includes("FOLLOW_UP_4")) {
      console.log(`${INDEX} already covers FOLLOW_UP_4 — not rebuilt.`);
    } else {
      await client.query("SET statement_timeout = '15min'");
      await client.query("SET lock_timeout = '5s'");
      const v2 = await indexDefinition(client, INDEX_V2);
      const v2Usable = Boolean(v2?.includes("FOLLOW_UP_4")) && (await indexIsValid(client, INDEX_V2));
      if (v2Usable) {
        console.log(`${INDEX_V2} is already built and valid (an earlier run stopped part-way) — reusing it.`);
      } else {
        // An earlier run may have died during the build, leaving an INVALID or incomplete v2.
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX_V2}"`);
        await client.query("SET lock_timeout = 0");
        await client.query(`CREATE UNIQUE INDEX CONCURRENTLY "${INDEX_V2}" ON "Message" ("leadId", "type") WHERE ${INDEX_PREDICATE}`);
        await client.query("SET lock_timeout = '5s'");
      }
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`);
      await client.query(`ALTER INDEX "${INDEX_V2}" RENAME TO "${INDEX}"`);
      console.log(`${INDEX} rebuilt to cover FOLLOW_UP_4.`);
    }

    // Self-check: never report success while the delivery claim is incomplete.
    const final = await indexDefinition(client, INDEX);
    if (!final) throw new Error(`Self-check failed: index ${INDEX} does not exist.`);
    if (!final.includes("FOLLOW_UP_4")) throw new Error(`Self-check failed: ${INDEX} does not cover FOLLOW_UP_4: ${final}`);
    if (!/UNIQUE/i.test(final)) throw new Error(`Self-check failed: ${INDEX} is not unique: ${final}`);
    const { rows: invalid } = await client.query(
      `SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE NOT i.indisvalid AND c.relname IN ($1, $2)`,
      [INDEX, INDEX_V2],
    );
    if (invalid.length) throw new Error(`Self-check failed: invalid index left behind: ${invalid.map((r) => r.relname).join(", ")}`);
    console.log(`Self-check passed: ${INDEX} is unique, valid and covers FOLLOW_UP_4.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
