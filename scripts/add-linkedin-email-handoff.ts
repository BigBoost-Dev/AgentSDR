/**
 * LinkedIn-to-email hand-off: put a person into an email campaign when their LinkedIn
 * invite is withdrawn, or when the LinkedIn sequence ends with no reply.
 *
 * Run with:  bun run scripts/add-linkedin-email-handoff.ts
 *
 * Two transactions, "Lead" first and committed, then "Campaign" (so the Lead lock is never held while
 * waiting on "Campaign" or outreach_campaigns, which the foreign keys lock). No enum change here.
 *   "Lead":
 *     "completedAt" timestamp(3) NULL: when the sequence ended (stamped on every
 *       COMPLETED write). Leads completed before this migration stay NULL and are
 *       never handed off.
 *     "emailHandoffAt" timestamp(3) NULL: when the hand-off was decided (once, whatever the result).
 *     "emailHandoffCampaignId" uuid NULL: the email campaign it was meant for.
 *     "emailHandoffResult" text NULL: enrolled, duplicate, suppressed, dnc, replied,
 *       active_elsewhere, no_email, or stopped_by_accept.
 *   "Campaign":
 *     "emailCampaignIfNotAcceptedId" uuid NULL -> outreach_campaigns(id) ON DELETE SET NULL
 *     "emailCampaignAfterSequenceId" uuid NULL -> outreach_campaigns(id) ON DELETE SET NULL
 *     "emailAfterSequenceDelayDays" integer NOT NULL DEFAULT 3, CHECK 0..60
 *       ("Campaign_email_after_delay_chk"): email starts this many days after completedAt.
 *
 * Both campaign ids default to NULL = no hand-off, so an untouched campaign behaves as before.
 * Additive and idempotent: re-running changes nothing. Run it before deploying the code.
 * Ends with a self-check that fails loudly if anything is missing.
 */
import { Client } from "pg";

const LEAD_DDL = `
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "completedAt" timestamp(3);
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "emailHandoffAt" timestamp(3);
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "emailHandoffCampaignId" uuid;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "emailHandoffResult" text;
`;

const CAMPAIGN_DDL = `
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "emailCampaignIfNotAcceptedId" uuid;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "emailCampaignAfterSequenceId" uuid;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "emailAfterSequenceDelayDays" integer NOT NULL DEFAULT 3;
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Campaign_emailCampaignIfNotAcceptedId_fkey' AND conrelid = '"Campaign"'::regclass) THEN
    ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_emailCampaignIfNotAcceptedId_fkey"
      FOREIGN KEY ("emailCampaignIfNotAcceptedId") REFERENCES outreach_campaigns(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Campaign_emailCampaignAfterSequenceId_fkey' AND conrelid = '"Campaign"'::regclass) THEN
    ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_emailCampaignAfterSequenceId_fkey"
      FOREIGN KEY ("emailCampaignAfterSequenceId") REFERENCES outreach_campaigns(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Campaign_email_after_delay_chk' AND conrelid = '"Campaign"'::regclass) THEN
    ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_email_after_delay_chk"
      CHECK ("emailAfterSequenceDelayDays" BETWEEN 0 AND 60);
  END IF;
END
$fk$;
`;

type ColumnRow = { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null };

const EXPECTED: { table: string; column: string; type: string; nullable: boolean; defaultValue?: string }[] = [
  { table: "Lead", column: "completedAt", type: "timestamp", nullable: true },
  { table: "Lead", column: "emailHandoffAt", type: "timestamp", nullable: true },
  { table: "Lead", column: "emailHandoffCampaignId", type: "uuid", nullable: true },
  { table: "Lead", column: "emailHandoffResult", type: "text", nullable: true },
  { table: "Campaign", column: "emailCampaignIfNotAcceptedId", type: "uuid", nullable: true },
  { table: "Campaign", column: "emailCampaignAfterSequenceId", type: "uuid", nullable: true },
  { table: "Campaign", column: "emailAfterSequenceDelayDays", type: "integer", nullable: false, defaultValue: "3" },
];

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

    // Each transaction commits before the next starts, so only one table is locked at a time.
    for (const ddl of [LEAD_DDL, CAMPAIGN_DDL]) {
      try {
        await client.query("BEGIN");
        await client.query(ddl);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    console.log(`"Lead" and "Campaign" hand-off columns, both foreign keys and "Campaign_email_after_delay_chk" are in place.`);

    // Self-check: never report success while something is missing.
    const { rows } = await client.query<ColumnRow>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name IN ('Lead', 'Campaign')`,
    );
    for (const want of EXPECTED) {
      const got = rows.find((r) => r.table_name === want.table && r.column_name === want.column);
      if (!got) throw new Error(`Self-check failed: "${want.table}"."${want.column}" is missing.`);
      if (!got.data_type.startsWith(want.type)) throw new Error(`Self-check failed: "${want.table}"."${want.column}" is ${got.data_type}, expected ${want.type}.`);
      if ((got.is_nullable === "YES") !== want.nullable) throw new Error(`Self-check failed: "${want.table}"."${want.column}" nullability is wrong.`);
      if (want.defaultValue !== undefined && got.column_default !== want.defaultValue) {
        throw new Error(`Self-check failed: "${want.table}"."${want.column}" default is ${got.column_default}, expected ${want.defaultValue}.`);
      }
    }
    const { rows: constraints } = await client.query<{ conname: string; contype: string; confdeltype: string }>(
      `SELECT conname, contype, confdeltype FROM pg_constraint
       WHERE conrelid = '"Campaign"'::regclass
         AND conname IN ('Campaign_emailCampaignIfNotAcceptedId_fkey', 'Campaign_emailCampaignAfterSequenceId_fkey', 'Campaign_email_after_delay_chk')`,
    );
    for (const name of ["Campaign_emailCampaignIfNotAcceptedId_fkey", "Campaign_emailCampaignAfterSequenceId_fkey"]) {
      const row = constraints.find((c) => c.conname === name);
      if (!row || row.contype !== "f") throw new Error(`Self-check failed: foreign key ${name} is missing.`);
      if (row.confdeltype !== "n") throw new Error(`Self-check failed: ${name} must be ON DELETE SET NULL.`);
    }
    if (!constraints.some((c) => c.conname === "Campaign_email_after_delay_chk" && c.contype === "c")) {
      throw new Error(`Self-check failed: "Campaign_email_after_delay_chk" is missing.`);
    }
    console.log(`Self-check passed: seven columns, two ON DELETE SET NULL foreign keys and the CHECK are in place.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
