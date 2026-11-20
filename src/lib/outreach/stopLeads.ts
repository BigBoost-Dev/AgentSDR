import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { people } from "@/lib/leads/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { leadsInOrg } from "./orgScope";
import { outreachCampaigns, outreachLeads, outreachMailboxQueue, type OutreachLeadStatus } from "./schema";

/** Statuses with a step still to send; a lead in any other has already ended. */
const STOPPABLE: OutreachLeadStatus[] = ["pending", "initial_sent", "in_follow_up"];

export type StopLeadsResult = {
  /** Emails whose sequence was running and is now ended. */
  stopped: number;
  /** Emails in the campaign whose sequence had already ended (finished, replied, bounced, suppressed). */
  alreadyEnded: number;
  /** Emails that are not leads of this campaign. */
  notFound: string[];
};

/**
 * Ends the campaign's sequence for these addresses: no further step is
 * queued or sent, as if the sequence had run out (`sequence_completed`).
 * This is the "the lead converted in my app" stop, so unlike suppression it
 * leaves the person free to be contacted by a later campaign. The scheduler
 * re-reads a lead's status after taking it from the queue, so a send already
 * in flight is the only one that can still go out.
 *
 * Runs inside an organization scope; another organization's campaign is null.
 */
export async function stopCampaignLeads(campaignId: string, emails: string[]): Promise<StopLeadsResult | null> {
  const [campaign] = await db
    .select({ id: outreachCampaigns.id })
    .from(outreachCampaigns)
    .where(and(inOrg(outreachCampaigns), eq(outreachCampaigns.id, campaignId)))
    .limit(1);
  if (!campaign) return null;

  const wanted = [...new Set(emails.map((email) => email.trim().toLowerCase()))];
  if (wanted.length === 0) return { stopped: 0, alreadyEnded: 0, notFound: [] };

  return db.transaction(async (tx) => {
    const leads = await tx
      .select({ id: outreachLeads.id, status: outreachLeads.sequenceStatus, email: sql<string>`lower(${people.email})` })
      .from(outreachLeads)
      .innerJoin(people, eq(outreachLeads.personId, people.id))
      .where(and(
        leadsInOrg(),
        inOrg(people),
        eq(outreachLeads.campaignId, campaignId),
        inArray(sql`lower(${people.email})`, wanted),
      ))
      .for("update", { of: outreachLeads });

    const running = leads.filter((lead) => STOPPABLE.includes(lead.status));
    if (running.length) {
      const ids = running.map((lead) => lead.id);
      await tx.delete(outreachMailboxQueue).where(inArray(outreachMailboxQueue.leadId, ids));
      await tx
        .update(outreachLeads)
        .set({ sequenceStatus: "sequence_completed", nextSendAt: null, updatedAt: new Date() })
        .where(inArray(outreachLeads.id, ids));
    }

    const found = new Set(leads.map((lead) => lead.email));
    const stoppedEmails = new Set(running.map((lead) => lead.email));
    return {
      stopped: stoppedEmails.size,
      alreadyEnded: [...found].filter((email) => !stoppedEmails.has(email)).length,
      notFound: wanted.filter((email) => !found.has(email)),
    };
  });
}

/**
 * Ends one person's running sequence in one email campaign, exactly as stopCampaignLeads does
 * (queue entries removed, `sequence_completed`, nextSendAt cleared), but addressed by Person id and
 * usable inside a caller's transaction. Returns how many enrollments were stopped (0 or 1).
 * Used when a LinkedIn accept wins over an email hand-off.
 */
export async function stopPersonEmailEnrollment(
  executor: Pick<typeof db, "select" | "update" | "delete">,
  campaignId: string,
  personId: string,
): Promise<number> {
  const running = await executor
    .select({ id: outreachLeads.id })
    .from(outreachLeads)
    .where(and(
      leadsInOrg(),
      eq(outreachLeads.campaignId, campaignId),
      eq(outreachLeads.personId, personId),
      inArray(outreachLeads.sequenceStatus, STOPPABLE),
    ));
  if (!running.length) return 0;
  const ids = running.map((lead) => lead.id);
  await executor.delete(outreachMailboxQueue).where(inArray(outreachMailboxQueue.leadId, ids));
  await executor
    .update(outreachLeads)
    .set({ sequenceStatus: "sequence_completed", nextSendAt: null, updatedAt: new Date() })
    // Re-check the status: a row the sender moved to bounced or suppressed meanwhile is left as it is.
    .where(and(inArray(outreachLeads.id, ids), inArray(outreachLeads.sequenceStatus, STOPPABLE)));
  return ids.length;
}
