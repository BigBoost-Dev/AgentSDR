import "server-only";

import { and, asc, eq, inArray, isNotNull, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { people } from "@/lib/leads/schema";
import { campaigns, connections, leads } from "@/lib/linkedin/schema";
import { outreachCampaigns, outreachLeads } from "@/lib/outreach/schema";
import { stopPersonEmailEnrollment } from "@/lib/outreach/stopLeads";
import { crmRecords } from "@/lib/crm/schema";
import { leadsInOrg } from "@/lib/outreach/orgScope";
import { addPeopleToEmailCampaignInTransaction } from "@/lib/leads/campaignAssignments";
import { isPersonDoNotContact, lockPersonContactPolicyScope } from "@/lib/crm/policies";
import { inOrg } from "@/lib/tenancy/scope";
import { serializeError } from "@/lib/linkedin/serializeError";
import {
  WITHDRAW_SETTLE_MS,
  acceptReleaseDecision,
  enrollmentHandoffResult,
  handoffDue,
  handoffGuardResult,
  type HandoffResult,
} from "@/lib/linkedin/emailHandoff";

/** Hand-offs decided per organization per outreach run. */
export const HANDOFF_BATCH = 50;

/** Email statuses with a step still to send (see stopLeads.ts STOPPABLE). */
const ACTIVE_EMAIL_STATUSES = ["pending", "initial_sent", "in_follow_up"] as const;
/** A reply is in, or being processed. */
const REPLIED_EMAIL_STATUSES = ["reply_received", "reply_processing"] as const;

export type HandoffRunSummary = { considered: number; skipped: number; results: Partial<Record<HandoffResult, number>> };

const noConnectionRow = () =>
  notExists(db.select({ id: connections.id }).from(connections).where(and(inOrg(connections), eq(connections.leadId, leads.id))));

/**
 * Hands LinkedIn leads over to email, in the organization in scope. Run once per organization
 * per outreach run (not tied to an account or its working hours: email has its own schedule).
 *
 *  - Withdrawn invitation (after a 1-hour settle period, no Connection row): the campaign's
 *    "if not accepted" email campaign.
 *  - Sequence completed with no reply, `emailAfterSequenceDelayDays` after completedAt: the
 *    campaign's "after sequence" email campaign. Leads with no completedAt are never handed off.
 *
 * One transaction per lead: take the Person contact-policy lock (reply ingest takes the same one),
 * re-read the lead, run the guards (dnc, replied, active_elsewhere, no_email), enroll through the
 * shared enrollment rules and record the outcome, so every lead is decided exactly once.
 */
export async function handOffLinkedinLeadsToEmail(now: Date = new Date()): Promise<HandoffRunSummary> {
  const summary: HandoffRunSummary = { considered: 0, skipped: 0, results: {} };
  const nowIso = now.toISOString();
  const settleIso = new Date(now.getTime() - WITHDRAW_SETTLE_MS).toISOString();

  const candidates = await db
    .select({ id: leads.id, personId: leads.personId })
    .from(leads)
    .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
    .where(and(
      inOrg(leads),
      inOrg(campaigns),
      eq(campaigns.status, "ACTIVE"),
      // PERSONAL campaigns' LinkedIn replies never reach CRM ingest, so nothing would stop the email.
      eq(campaigns.type, "REGULAR"),
      isNull(leads.emailHandoffAt),
      isNull(leads.supersededByLeadId),
      or(
        and(
          eq(leads.status, "WITHDRAWN"),
          isNotNull(campaigns.emailCampaignIfNotAcceptedId),
          sql`${leads.inviteWithdrawnAt} <= ${settleIso}::timestamp`,
          noConnectionRow(),
        ),
        and(
          eq(leads.status, "COMPLETED"),
          isNotNull(campaigns.emailCampaignAfterSequenceId),
          isNotNull(leads.completedAt),
          sql`${leads.completedAt} <= ${nowIso}::timestamp - ${campaigns.emailAfterSequenceDelayDays} * interval '1 day'`,
        ),
      ),
    ))
    .orderBy(sql`coalesce(${leads.inviteWithdrawnAt}, ${leads.completedAt})`, asc(leads.id))
    .limit(HANDOFF_BATCH);

  summary.considered = candidates.length;
  for (const candidate of candidates) {
    try {
      const result = await handOffOne(candidate.id, candidate.personId, now);
      if (result === null) {
        summary.skipped += 1;
      } else {
        summary.results[result] = (summary.results[result] ?? 0) + 1;
        console.log(`[emailHandoff] Lead ${candidate.id}: ${result}`);
      }
    } catch (err) {
      // The transaction rolled back: the lead is undecided and is tried again on the next run.
      summary.skipped += 1;
      console.error(`[emailHandoff] Lead ${candidate.id} failed: ${serializeError(err)}`);
    }
  }
  if (summary.considered > 0) {
    console.log(`[emailHandoff] ${summary.considered} considered, ${summary.skipped} skipped, results ${JSON.stringify(summary.results)}`);
  }
  return summary;
}

/** One lead, one transaction. null = nothing written (state changed since the candidate read). */
async function handOffOne(leadId: string, personId: string, now: Date): Promise<HandoffResult | null> {
  return db.transaction(async (tx) => {
    await lockPersonContactPolicyScope(tx, personId);

    const [row] = await tx
      .select({
        status: leads.status,
        emailHandoffAt: leads.emailHandoffAt,
        inviteWithdrawnAt: leads.inviteWithdrawnAt,
        completedAt: leads.completedAt,
        campaignStatus: campaigns.status,
        emailCampaignIfNotAcceptedId: campaigns.emailCampaignIfNotAcceptedId,
        emailCampaignAfterSequenceId: campaigns.emailCampaignAfterSequenceId,
        emailAfterSequenceDelayDays: campaigns.emailAfterSequenceDelayDays,
      })
      .from(leads)
      .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(and(inOrg(leads), inOrg(campaigns), eq(campaigns.type, "REGULAR"), eq(leads.id, leadId), isNull(leads.emailHandoffAt)))
      .for("update", { of: leads });
    if (!row) return null;

    const [connection] = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(and(inOrg(connections), eq(connections.leadId, leadId)))
      .limit(1);

    const due = handoffDue(
      { status: row.status, emailHandoffAt: row.emailHandoffAt, inviteWithdrawnAt: row.inviteWithdrawnAt, completedAt: row.completedAt, hasConnection: Boolean(connection) },
      {
        status: row.campaignStatus,
        emailCampaignIfNotAcceptedId: row.emailCampaignIfNotAcceptedId,
        emailCampaignAfterSequenceId: row.emailCampaignAfterSequenceId,
        emailAfterSequenceDelayDays: row.emailAfterSequenceDelayDays,
      },
      now,
    );
    if (!due) return null;

    const [person] = await tx.select({ email: people.email }).from(people).where(and(inOrg(people), eq(people.id, personId))).limit(1);

    // Has the person replied anywhere? (No shared helper exists: a LinkedIn lead REPLIED, or an email
    // enrollment with a reply in or being processed.)
    const [linkedinReplied] = await tx
      .select({ id: leads.id })
      .from(leads)
      .where(and(inOrg(leads), eq(leads.personId, personId), eq(leads.status, "REPLIED")))
      .limit(1);
    const [emailReplied] = await tx
      .select({ id: outreachLeads.id })
      .from(outreachLeads)
      .where(and(leadsInOrg(), eq(outreachLeads.personId, personId), inArray(outreachLeads.sequenceStatus, [...REPLIED_EMAIL_STATUSES])))
      .limit(1);
    // Any inbound reply from the person on any channel, as recorded by CRM ingest (which commits it
    // under this same person lock). Deliberately cautious: an out-of-office reply also blocks.
    const [crmInbound] = await tx
      .select({ id: crmRecords.id })
      .from(crmRecords)
      .where(and(inOrg(crmRecords), eq(crmRecords.personId, personId), isNotNull(crmRecords.lastInboundAt)))
      .limit(1);
    const [activeElsewhere] = await tx
      .select({ id: outreachLeads.id })
      .from(outreachLeads)
      .where(and(
        leadsInOrg(),
        eq(outreachLeads.personId, personId),
        ne(outreachLeads.campaignId, due.emailCampaignId),
        inArray(outreachLeads.sequenceStatus, [...ACTIVE_EMAIL_STATUSES]),
      ))
      .limit(1);

    const guard = handoffGuardResult({
      doNotContact: await isPersonDoNotContact(tx, personId),
      replied: Boolean(linkedinReplied || emailReplied || crmInbound),
      activeElsewhere: Boolean(activeElsewhere),
      hasEmail: Boolean(person?.email),
    });

    let result: HandoffResult;
    if (guard) {
      result = guard;
    } else {
      result = enrollmentHandoffResult(await addPeopleToEmailCampaignInTransaction(tx, due.emailCampaignId, [personId]));
    }

    await tx
      .update(leads)
      .set({ emailHandoffAt: now, emailHandoffCampaignId: due.emailCampaignId, emailHandoffResult: result })
      .where(and(inOrg(leads), eq(leads.id, leadId), isNull(leads.emailHandoffAt)));
    return result;
  });
}

/**
 * The first of these email campaign ids that is not a campaign of the organization in scope,
 * or null when all are (used to validate the hand-off settings of a LinkedIn campaign).
 */
export async function firstUnknownEmailCampaignId(ids: (string | null | undefined)[]): Promise<string | null> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return null;
  const found = await db
    .select({ id: outreachCampaigns.id })
    .from(outreachCampaigns)
    .where(and(inOrg(outreachCampaigns), inArray(outreachCampaigns.id, wanted)));
  const known = new Set(found.map((row) => row.id));
  return wanted.find((id) => !known.has(id)) ?? null;
}

/**
 * An accept has just moved the lead out of WITHDRAWN. In one transaction (person lock first, the same
 * lock the hand-off and reply ingest take) re-read the lead FOR UPDATE and, only when a hand-off had
 * been decided, release it: clear `emailHandoffAt` (so the lead may later be handed to email B), and
 * when the fresh result is `enrolled` stop that email enrollment and record `stopped_by_accept`.
 * It decides from the fresh row, not from the caller's copy, which may predate a hand-off that
 * committed while the caller was waiting on the provider. Call it only after the status update
 * committed: from then on a hand-off skips the lead (it re-checks WITHDRAWN under the lock).
 * Returns the number of email enrollments stopped.
 */
export async function releaseEmailHandoffOnAccept(leadId: string, personId: string): Promise<number> {
  return db.transaction(async (tx) => {
    await lockPersonContactPolicyScope(tx, personId);
    const [fresh] = await tx
      .select({ emailHandoffAt: leads.emailHandoffAt, emailHandoffResult: leads.emailHandoffResult, emailHandoffCampaignId: leads.emailHandoffCampaignId })
      .from(leads)
      .where(and(inOrg(leads), eq(leads.id, leadId)))
      .for("update");
    if (!fresh) return 0;
    const decision = acceptReleaseDecision(fresh);
    if (!decision.release) return 0;
    const stopped = decision.stopCampaignId ? await stopPersonEmailEnrollment(tx, decision.stopCampaignId, personId) : 0;
    await tx
      .update(leads)
      .set({ emailHandoffAt: null, ...(decision.stopCampaignId && { emailHandoffResult: "stopped_by_accept" }) })
      .where(and(inOrg(leads), eq(leads.id, leadId)));
    return stopped;
  });
}
