/**
 * LinkedIn invite withdrawal: withdraw a connection request that is still
 * unaccepted after N working days.
 *
 * Run with:  bun run scripts/add-linkedin-invite-withdrawal.ts
 *
 * Two phases, because Postgres will not let all of this share a transaction:
 *
 *  1. "LeadStatus" gains WITHDRAWN (ALTER TYPE ... ADD VALUE, autocommit; a new
 *     enum value cannot be used in the transaction that adds it). WITHDRAWN means
 *     "we cancelled the pending invitation"; it is not CANCELLED, which means
 *     something else.
 *  2. One transaction adds the columns:
 *       "Campaign"."withdrawAfterWorkingDays" integer NULL, with the CHECK
 *         "Campaign_withdraw_after_chk" (null, or 1..60). NULL = never withdraw,
 *         which is today's behaviour, so an untouched campaign is unaffected.
 *       "Lead"."inviteWithdrawnAt" timestamp(3) NULL: when the invitation was withdrawn.
 *       "Lead"."withdrawRetryCount" integer NOT NULL DEFAULT 0: failed withdraw attempts
 *         (the engine gives up on a lead after 3).
 *
 * The script ends by reading the catalogs and fails loudly if anything is missing.
 *
 * Additive and idempotent: re-running changes nothing. Run it before the code that
 * reads these columns is deployed. Postgres cannot drop an enum value; the extra
 * WITHDRAWN is harmless if the code is rolled back.
 */
import { Client } from "pg";

// "Lead" first, then "Campaign": the app reads Lead then joins Campaign, so taking the
// locks in that order (each ALTER is brief, lock_timeout 5s) avoids a lock-order deadlock.
const COLUMNS_DDL = `
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "inviteWithdrawnAt" timestamp(3);
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "withdrawRetryCount" integer NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "withdrawAfterWorkingDays" integer;
DO $chk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Campaign_withdraw_after_chk' AND conrelid = '"Campaign"'::regclass
  ) THEN
    ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_withdraw_after_chk" CHECK (
      "withdrawAfterWorkingDays" IS NULL OR "withdrawAfterWorkingDays" BETWEEN 1 AND 60
    );
  END IF;
END
$chk$;
`;

type ColumnRow = { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null };

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
    await client.query(`ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'WITHDRAWN'`);
    console.log(`"LeadStatus" has WITHDRAWN.`);

    // Phase 2: columns and the CHECK, in one transaction.
    try {
      await client.query("BEGIN");
      await client.query(COLUMNS_DDL);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    console.log(`"Campaign" and "Lead" columns and "Campaign_withdraw_after_chk" are in place.`);

    // Self-check: never report success while something is missing.
    const { rows: enumRows } = await client.query(
      `SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'LeadStatus' AND e.enumlabel = 'WITHDRAWN'`,
    );
    if (!enumRows.length) throw new Error(`Self-check failed: "LeadStatus" has no WITHDRAWN value.`);

    const { rows } = await client.query<ColumnRow>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND ((table_name = 'Lead' AND column_name IN ('inviteWithdrawnAt', 'withdrawRetryCount'))
           OR (table_name = 'Campaign' AND column_name = 'withdrawAfterWorkingDays'))`,
    );
    const column = (table: string, name: string) => rows.find((r) => r.table_name === table && r.column_name === name);
    const withdrawAfter = column("Campaign", "withdrawAfterWorkingDays");
    if (!withdrawAfter || withdrawAfter.data_type !== "integer" || withdrawAfter.is_nullable !== "YES") {
      throw new Error(`Self-check failed: "Campaign"."withdrawAfterWorkingDays" must be a nullable integer.`);
    }
    const withdrawnAt = column("Lead", "inviteWithdrawnAt");
    if (!withdrawnAt || !withdrawnAt.data_type.startsWith("timestamp") || withdrawnAt.is_nullable !== "YES") {
      throw new Error(`Self-check failed: "Lead"."inviteWithdrawnAt" must be a nullable timestamp.`);
    }
    const retries = column("Lead", "withdrawRetryCount");
    if (!retries || retries.data_type !== "integer" || retries.is_nullable !== "NO" || retries.column_default !== "0") {
      throw new Error(`Self-check failed: "Lead"."withdrawRetryCount" must be integer NOT NULL DEFAULT 0.`);
    }
    const { rows: check } = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'Campaign_withdraw_after_chk' AND conrelid = '"Campaign"'::regclass`,
    );
    if (!check.length) throw new Error(`Self-check failed: "Campaign_withdraw_after_chk" does not exist.`);
    console.log(`Self-check passed: WITHDRAWN, the three columns and the CHECK are in place.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
