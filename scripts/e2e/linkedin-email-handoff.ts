/**
 * End-to-end check of the LinkedIn-to-email hand-off, against a disposable database.
 *
 *   E2E_ALLOW=1 DATABASE_URL=postgres://postgres@127.0.0.1:55432/agentsdr_e2e DATABASE_SSL=disable \
 *     bun run --conditions=react-server scripts/e2e/linkedin-email-handoff.ts
 *
 * Runs the real `handOffLinkedinLeadsToEmail` (and the real reply ingest and accept flow) against
 * seeded rows in its own organization. No provider is called: the accept check passes a chat id so
 * Unipile is never reached. Prints PASS or FAIL per check and exits non-zero when any fails.
 *
 * It refuses to run unless E2E_ALLOW=1 is set AND DATABASE_URL points at localhost: it writes
 * fixture data and must never touch a production database.
 */
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";

if (process.env.E2E_ALLOW !== "1") {
  console.error("Refusing to run: set E2E_ALLOW=1 to confirm DATABASE_URL is a disposable, non-production database.");
  process.exit(1);
}
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(1);
}

const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { outreachCampaigns, outreachLeads, suppressionList } = await import("@/lib/outreach/schema");
const { campaigns, connections, leads, linkedInAccounts } = await import("@/lib/linkedin/schema");
const { currentOrganizationId, runInOrganization } = await import("@/lib/tenancy/scope");
const { ensureCrmDefaults } = await import("@/lib/crm/defaults");
const { ingestInboundReply } = await import("@/lib/crm/conversations");
const { setPersonDoNotContactInTransaction } = await import("@/lib/crm/policies");
const { withCrmTransaction } = await import("@/lib/crm/repository");
const { handOffLinkedinLeadsToEmail } = await import("@/lib/linkedin/emailHandoff.server");
const { processLeadAcceptance } = await import("@/lib/linkedin/acceptanceMessage");

const token = crypto.randomUUID().slice(0, 8);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date();
const ago = (ms: number) => new Date(T0.getTime() - ms);

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────
async function newPerson(label: string, withEmail = true) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [person] = await db.insert(people).values({
    organizationId: currentOrganizationId(),
    email: withEmail ? `${label}-${suffix}@handoff.test` : null,
    linkedinUrl: `https://linkedin.com/in/${label}-${suffix}`,
    fullName: `${label} fixture`,
    source: "linkedin-email-handoff-e2e",
  }).returning();
  assert(person);
  return person;
}

async function emailCampaign(name: string) {
  const [row] = await db.insert(outreachCampaigns).values({ organizationId: currentOrganizationId(), name: `${name} ${token}`, status: "active" }).returning();
  assert(row);
  return row;
}

async function linkedinCampaign(over: Partial<typeof campaigns.$inferInsert> = {}) {
  const [row] = await db.insert(campaigns).values({
    organizationId: currentOrganizationId(),
    name: `LinkedIn ${crypto.randomUUID().slice(0, 6)}`,
    status: "ACTIVE",
    updatedAt: new Date(),
    ...over,
  }).returning();
  assert(row);
  return row;
}

async function linkedinLead(personId: string, campaignId: string, over: Partial<typeof leads.$inferInsert>) {
  const [row] = await db.insert(leads).values({
    organizationId: currentOrganizationId(),
    personId,
    campaignId,
    status: "WITHDRAWN",
    providerId: `provider-${crypto.randomUUID().slice(0, 8)}`,
    updatedAt: new Date(),
    ...over,
  }).returning();
  assert(row);
  return row;
}

async function lead(id: string) {
  const [row] = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
  assert(row, "lead exists");
  return row;
}

async function enrollments(personId: string, campaignId?: string) {
  return db.select().from(outreachLeads).where(and(
    eq(outreachLeads.personId, personId),
    ...(campaignId ? [eq(outreachLeads.campaignId, campaignId)] : []),
  ));
}

// ── The checks ───────────────────────────────────────────────────────────
async function main() {
  await ensureCrmDefaults();
  const emailA = await emailCampaign("Email A");
  const emailB = await emailCampaign("Email B");
  const emailX = await emailCampaign("Email X (another campaign)");
  const li = await linkedinCampaign({ emailCampaignIfNotAcceptedId: emailA.id, emailCampaignAfterSequenceId: emailB.id, emailAfterSequenceDelayDays: 4 });
  const liOther = await linkedinCampaign(); // no hand-off; holds a second lead of a person

  // Withdrawn leads, all past the 1-hour settle period unless noted.
  const happy = await newPerson("happy");
  const happyLead = await linkedinLead(happy.id, li.id, { inviteWithdrawnAt: ago(3 * HOUR) });

  const dncPerson = await newPerson("dnc");
  const dncLead = await linkedinLead(dncPerson.id, li.id, { inviteWithdrawnAt: ago(3 * HOUR) });
  await withCrmTransaction((tx) => setPersonDoNotContactInTransaction(tx, {
    personId: dncPerson.id, reason: "fixture", source: "human", actorType: "authenticated_operator",
  }));

  const repliedLinkedin = await newPerson("replied-linkedin");
  const repliedLinkedinLead = await linkedinLead(repliedLinkedin.id, li.id, { inviteWithdrawnAt: ago(3 * HOUR) });
  await linkedinLead(repliedLinkedin.id, liOther.id, { status: "REPLIED" });

  const repliedEmail = await newPerson("replied-email");
  const repliedEmailLead = await linkedinLead(repliedEmail.id, li.id, { inviteWithdrawnAt: ago(3 * HOUR) });
  await db.insert(outreachLeads).values({ personId: repliedEmail.id, campaignId: emailX.id, sequenceStatus: "reply_received" });

  const elsewhere = await newPerson("elsewhere");
  const elsewhereLead = await linkedinLead(elsewhere.id, li.id, { inviteWithdrawnAt: ago(3 * HOUR) });
  await db.insert(outreachLeads).values({ personId: elsewhere.id, campaignId: emailX.id, sequenceStatus: "in_follow_up" });

  const noEmail = await newPerson("no-email", false);
  const noEmailLead = await linkedinLead(noEmail.id, li.id, { inviteWithdrawnAt: ago(3 * HOUR) });

  const suppressed = await newPerson("suppressed");
  const suppressedLead = await linkedinLead(suppressed.id, li.id, { inviteWithdrawnAt: ago(3 * HOUR) });
  await db.insert(suppressionList).values({ organizationId: currentOrganizationId(), email: suppressed.email!, reason: "manual" as never });

  const settling = await newPerson("settling");
  const settlingLead = await linkedinLead(settling.id, li.id, { inviteWithdrawnAt: ago(30 * 60_000) });

  const accepted = await newPerson("known-accept");
  const acceptedLead = await linkedinLead(accepted.id, li.id, { inviteWithdrawnAt: ago(3 * HOUR) });
  await db.insert(connections).values({
    organizationId: currentOrganizationId(), providerId: acceptedLead.providerId!, leadId: acceptedLead.id,
    linkedinAccountId: null, chatId: null, updatedAt: new Date(),
  });

  // Completed leads (delay 4 days).
  const doneSoon = await newPerson("done-soon");
  const doneSoonLead = await linkedinLead(doneSoon.id, li.id, { status: "COMPLETED", completedAt: ago(2 * DAY) });
  const doneOld = await newPerson("done-old");
  const doneOldLead = await linkedinLead(doneOld.id, li.id, { status: "COMPLETED", completedAt: ago(5 * DAY) });
  const doneLegacy = await newPerson("done-legacy");
  const doneLegacyLead = await linkedinLead(doneLegacy.id, li.id, { status: "COMPLETED", completedAt: null });

  await handOffLinkedinLeadsToEmail(T0);
  const second = await handOffLinkedinLeadsToEmail(T0);

  await check("two runs enroll a withdrawn lead exactly once", async () => {
    assert.equal((await enrollments(happy.id, emailA.id)).length, 1);
    assert.equal((await enrollments(happy.id, emailA.id))[0]!.sequenceStatus, "pending");
    const row = await lead(happyLead.id);
    assert.equal(row.emailHandoffResult, "enrolled");
    assert.equal(row.emailHandoffCampaignId, emailA.id);
    assert(row.emailHandoffAt);
    assert.equal(second.results.enrolled ?? 0, 0, "the second run enrolls nobody");
  });

  await check("a person who is Do Not Contact is skipped with result dnc", async () => {
    assert.equal((await lead(dncLead.id)).emailHandoffResult, "dnc");
    assert.equal((await enrollments(dncPerson.id)).length, 0);
  });

  await check("a person with a REPLIED LinkedIn lead is skipped with result replied", async () => {
    assert.equal((await lead(repliedLinkedinLead.id)).emailHandoffResult, "replied");
    assert.equal((await enrollments(repliedLinkedin.id, emailA.id)).length, 0);
  });

  await check("a person with a reply_received email enrollment is skipped with result replied", async () => {
    assert.equal((await lead(repliedEmailLead.id)).emailHandoffResult, "replied");
    assert.equal((await enrollments(repliedEmail.id, emailA.id)).length, 0);
  });

  await check("a person active in another email campaign is skipped with result active_elsewhere", async () => {
    assert.equal((await lead(elsewhereLead.id)).emailHandoffResult, "active_elsewhere");
    assert.equal((await enrollments(elsewhere.id, emailA.id)).length, 0);
  });

  await check("a person with no email is skipped with result no_email", async () => {
    assert.equal((await lead(noEmailLead.id)).emailHandoffResult, "no_email");
  });

  await check("a suppressed email gives result suppressed and no enrollment", async () => {
    assert.equal((await lead(suppressedLead.id)).emailHandoffResult, "suppressed");
    assert.equal((await enrollments(suppressed.id, emailA.id)).length, 0);
  });

  await check("a WITHDRAWN lead inside the 1-hour settle period is not handed off (until it has settled)", async () => {
    const before = await lead(settlingLead.id);
    assert.equal(before.emailHandoffAt, null);
    assert.equal((await enrollments(settling.id)).length, 0);
    await handOffLinkedinLeadsToEmail(new Date(T0.getTime() + 2 * HOUR));
    assert.equal((await lead(settlingLead.id)).emailHandoffResult, "enrolled");
  });

  await check("a WITHDRAWN lead with a Connection row (a known accept) is never handed off", async () => {
    assert.equal((await lead(acceptedLead.id)).emailHandoffAt, null);
    assert.equal((await enrollments(accepted.id)).length, 0);
  });

  await check("a COMPLETED lead before its delay is not handed off; after the delay it is", async () => {
    assert.equal((await lead(doneSoonLead.id)).emailHandoffAt, null, "2 days after completion, delay is 4");
    assert.equal((await enrollments(doneSoon.id)).length, 0);
    assert.equal((await lead(doneOldLead.id)).emailHandoffResult, "enrolled", "5 days after completion");
    assert.equal((await enrollments(doneOld.id, emailB.id)).length, 1);
    await handOffLinkedinLeadsToEmail(new Date(T0.getTime() + 3 * DAY));
    assert.equal((await lead(doneSoonLead.id)).emailHandoffResult, "enrolled", "5 days after completion now");
    assert.equal((await enrollments(doneSoon.id, emailB.id)).length, 1);
  });

  await check("a COMPLETED lead with no completedAt is never handed off", async () => {
    await handOffLinkedinLeadsToEmail(new Date(T0.getTime() + 400 * DAY));
    assert.equal((await lead(doneLegacyLead.id)).emailHandoffAt, null);
    assert.equal((await enrollments(doneLegacy.id)).length, 0);
  });

  await check("a reply ingested after enrollment leaves no active enrollment", async () => {
    const [before] = await enrollments(happy.id, emailA.id);
    assert.equal(before!.sequenceStatus, "pending");
    const suffix = crypto.randomUUID().slice(0, 8);
    await ingestInboundReply({
      personId: happy.id, channel: "email", accountRef: `mailbox-${token}@handoff.test`,
      providerThreadId: `thread-${suffix}`, idempotencyKey: `in-${suffix}`, providerMessageId: `pm-${suffix}`,
      subject: "Re: hello", bodyText: "Interested, tell me more", sentAt: new Date(),
    });
    const after = await enrollments(happy.id);
    assert(after.length > 0);
    assert(after.every((row) => !["pending", "initial_sent", "in_follow_up"].includes(row.sequenceStatus)), "no active enrollment remains");
    assert.equal(after.find((row) => row.campaignId === emailA.id)?.sequenceStatus, "reply_received");
  });

  // A late accept: the lead was handed to email while WITHDRAWN, then the invitation was accepted.
  // `copyOver` lets a check hand processLeadAcceptance a STALE copy of the lead (taken before the
  // hand-off committed), as the webhook does after waiting on the provider.
  async function lateAccept(label: string, copyOver: Partial<typeof leads.$inferSelect> = {}) {
    const person = await newPerson(label);
    const withdrawn = await linkedinLead(person.id, li.id, { inviteWithdrawnAt: ago(3 * HOUR) });
    const staleCopy = await lead(withdrawn.id); // taken BEFORE the hand-off
    await handOffLinkedinLeadsToEmail(T0);
    const handed = await lead(withdrawn.id);
    assert.equal(handed.emailHandoffResult, "enrolled");
    assert.equal((await enrollments(person.id, emailA.id))[0]!.sequenceStatus, "pending");

    // The accept arrives (connection recorded first, as the webhook does), then the accept flow runs.
    // A chat id is supplied and the campaign has no acceptance message, so no provider is called.
    const [connection] = await db.insert(connections).values({
      organizationId: currentOrganizationId(), providerId: handed.providerId!, leadId: handed.id,
      linkedinAccountId: null, chatId: "chat-fixture", updatedAt: new Date(),
    }).returning();
    // A real sender row: the accept flow records which account the lead is with (foreign key).
    const [sender] = await db.insert(linkedInAccounts).values({
      organizationId: currentOrganizationId(), linkedinId: `unipile-${label}-${token}`, username: `fixture-${label}-${token}`, updatedAt: new Date(),
    }).returning();
    const result = await processLeadAcceptance(
      { ...staleCopy, ...copyOver, linkedinUrl: person.linkedinUrl!, acceptanceMessage: null, acceptanceDelayDays: 0, variables: {} },
      { id: connection!.id, providerId: connection!.providerId, chatId: "chat-fixture" },
      { id: sender!.id, linkedinId: sender!.linkedinId },
      () => {},
    );
    assert.equal(result, "advanced");
    return { person, withdrawn };
  }

  await check("a late accept on an enrolled WITHDRAWN lead stops the enrollment (accept wins)", async () => {
    const { person, withdrawn } = await lateAccept("late-accept");
    assert.equal((await enrollments(person.id, emailA.id))[0]!.sequenceStatus, "sequence_completed");
    const after = await lead(withdrawn.id);
    assert.equal(after.emailHandoffResult, "stopped_by_accept");
    assert.equal(after.emailHandoffAt, null, "the hand-off decision is released so email B can follow later");
    assert.equal(after.status, "ACCEPT_MESSAGE_SENT");
    assert.equal(after.inviteWithdrawnAt, null);
  });

  await check("the accept still wins when its copy of the lead predates the hand-off (race)", async () => {
    // The copy handed to processLeadAcceptance says "never handed off"; the database row says enrolled.
    const { person, withdrawn } = await lateAccept("race-accept", { emailHandoffAt: null, emailHandoffResult: null, emailHandoffCampaignId: null });
    assert.equal((await enrollments(person.id, emailA.id))[0]!.sequenceStatus, "sequence_completed");
    assert.equal((await lead(withdrawn.id)).emailHandoffResult, "stopped_by_accept");
  });

  await check("a COMPLETED lead whose person has an inbound CRM reply is skipped as replied", async () => {
    const person = await newPerson("crm-replied");
    const done = await linkedinLead(person.id, li.id, { status: "COMPLETED", completedAt: ago(9 * DAY) });
    const suffix = crypto.randomUUID().slice(0, 8);
    await ingestInboundReply({
      personId: person.id, channel: "email", accountRef: `mailbox-${token}@handoff.test`,
      providerThreadId: `thread-${suffix}`, idempotencyKey: `in-${suffix}`, providerMessageId: `pm-${suffix}`,
      subject: "Re: hello", bodyText: "Out of office until Monday", sentAt: new Date(),
    });
    // Ingest also marks the LinkedIn lead REPLIED; put it back to COMPLETED so only the CRM record guard can stop it.
    await db.update(leads).set({ status: "COMPLETED" }).where(eq(leads.id, done.id));
    await handOffLinkedinLeadsToEmail(T0);
    assert.equal((await lead(done.id)).emailHandoffResult, "replied");
    assert.equal((await enrollments(person.id, emailB.id)).length, 0);
  });

  await check("a LinkedIn reply ingested for a COMPLETED lead marks it REPLIED", async () => {
    const person = await newPerson("li-replied");
    const done = await linkedinLead(person.id, li.id, { status: "COMPLETED", completedAt: ago(9 * DAY) });
    const suffix = crypto.randomUUID().slice(0, 8);
    await ingestInboundReply({
      personId: person.id, channel: "linkedin", accountRef: `li-account-${token}`,
      providerThreadId: `thread-${suffix}`, providerContactId: `contact-${suffix}`,
      idempotencyKey: `in-${suffix}`, providerMessageId: `pm-${suffix}`, bodyText: "Thanks, interested", sentAt: new Date(),
    });
    assert.equal((await lead(done.id)).status, "REPLIED");
    await handOffLinkedinLeadsToEmail(T0);
    assert.equal((await lead(done.id)).emailHandoffAt, null, "a REPLIED lead is not a hand-off candidate");
  });

  await check("a PERSONAL campaign never hands off", async () => {
    const personal = await linkedinCampaign({ type: "PERSONAL", emailCampaignIfNotAcceptedId: emailA.id, emailCampaignAfterSequenceId: emailB.id });
    const person = await newPerson("personal");
    const withdrawn = await linkedinLead(person.id, personal.id, { inviteWithdrawnAt: ago(3 * HOUR) });
    await handOffLinkedinLeadsToEmail(T0);
    assert.equal((await lead(withdrawn.id)).emailHandoffAt, null);
    assert.equal((await enrollments(person.id)).length, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) console.log("RESULT: FAIL");
  else console.log("RESULT: PASS");
  return failed;
}

const [org] = await db.insert(organizations).values({ name: `Email hand-off e2e ${token}`, slug: `email-handoff-e2e-${token}` }).returning();
assert(org);
await runInOrganization(org.id, main).then(
  (failures) => process.exit(failures > 0 ? 1 : 0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
