/**
 * Drafts the follow-up a rep scheduled ("Follow up later") once it is due.
 *
 * Scheduling parks the record as 'waiting' until `next_action_at` and keeps
 * the rep's note in the `record.follow_up_scheduled` event. Every few minutes
 * (scheduler job `crm-due-follow-up-drafts`) this finds records whose date
 * has passed, that still carry that note as current (nothing newer happened:
 * the event's context version is the record's), and has the AI write the
 * follow-up with the note as its brief (`generateFallbackDraft`, the same
 * prompt, review and failure handling as every other draft). The draft lands
 * as awaiting_review, never auto-sent, and the record moves to Action
 * required as a "Follow-up review". The model reads the thread as it is on
 * the day, so context that changed since scheduling is already in it.
 *
 * Idempotent: the draft is claimed under the record's lock (still waiting for
 * that very time, nothing yet drafted at this context version). A failed
 * attempt puts the record back as a plain "Due follow-up" for a person, keeps
 * its claim (a discarded draft) and is logged, never retried.
 */
import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { generateFallbackDraft } from "./drafts";
import { FOLLOW_UP_EVENT, followUpFromEventData } from "./followUpNote";
import { lockCrmRecord } from "./records";
import { withCrmTransaction } from "./repository";
import { crmDrafts, crmEvents, crmRecords } from "./schema";

export type DueFollowUpDraftSummary = { organizations: number; drafted: number; skipped: number; failed: number };

/** At most this many drafts per organization per run; the rest wait for the next one. */
const PER_ORGANIZATION_LIMIT = 10;

/** A record/version whose drafting failed before it could be claimed: not retried until the process restarts. */
const gaveUp = new Set<string>();

const dueCondition = (now: Date) => and(
  eq(crmRecords.workflowState, "waiting"),
  lte(crmRecords.nextActionAt, now),
  eq(crmEvents.eventType, FOLLOW_UP_EVENT),
  eq(crmEvents.contextVersion, crmRecords.contextVersion),
);

async function putBackAsDueFollowUp(recordId: string, contextVersion: number, dueAt: Date): Promise<void> {
  await withCrmTransaction(async (tx) => {
    const record = await lockCrmRecord(tx, recordId);
    // Only undo what the failed draft did: still this version, parked in error.
    if (record.contextVersion !== contextVersion || record.workflowState !== "error") return;
    const now = new Date();
    await tx.update(crmDrafts).set({ status: "discarded", updatedAt: now })
      .where(and(eq(crmDrafts.crmRecordId, record.id), eq(crmDrafts.expectedContextVersion, contextVersion), eq(crmDrafts.status, "failed")));
    await tx.update(crmRecords).set({ workflowState: "waiting", nextActionAt: dueAt, updatedAt: now })
      .where(eq(crmRecords.id, record.id));
  });
}

async function runOrganization(summary: DueFollowUpDraftSummary, now: Date): Promise<void> {
  const due = await db.select({
    recordId: crmRecords.id,
    contextVersion: crmRecords.contextVersion,
    nextActionAt: crmRecords.nextActionAt,
    toData: crmEvents.toData,
    actorRef: crmEvents.actorRef,
    eventAt: crmEvents.createdAt,
  })
    .from(crmRecords)
    .innerJoin(crmEvents, eq(crmEvents.crmRecordId, crmRecords.id))
    .where(and(inOrg(crmRecords), inOrg(crmEvents), dueCondition(now)))
    .orderBy(crmRecords.nextActionAt)
    .limit(PER_ORGANIZATION_LIMIT);
  for (const row of due) {
    const key = `${row.recordId}:${row.contextVersion}`;
    const followUp = followUpFromEventData(row.toData, { actorRef: row.actorRef, createdAt: row.eventAt });
    if (!followUp || !row.nextActionAt || new Date(followUp.dueAt).getTime() !== row.nextActionAt.getTime() || gaveUp.has(key)) {
      summary.skipped += 1;
      continue;
    }
    const dueAt = new Date(followUp.dueAt);
    try {
      const draft = await generateFallbackDraft(row.recordId, {}, null, { note: followUp.note, dueAt });
      if (draft) summary.drafted += 1;
      else {
        // Nothing to draft (no inbound message to answer, Do Not Contact) or
        // already claimed: it stays a plain Due follow-up for a person.
        gaveUp.add(key);
        summary.skipped += 1;
      }
    } catch (error) {
      summary.failed += 1;
      gaveUp.add(key);
      console.error(`[crm/dueFollowUpDrafts] Record ${row.recordId} failed:`, error instanceof Error ? error.message : error);
      try {
        await putBackAsDueFollowUp(row.recordId, row.contextVersion, dueAt);
      } catch (restoreError) {
        console.error(`[crm/dueFollowUpDrafts] Record ${row.recordId} could not be put back:`, restoreError instanceof Error ? restoreError.message : restoreError);
      }
    }
  }
}

export async function runDueFollowUpDrafts(options: { now?: Date } = {}): Promise<DueFollowUpDraftSummary> {
  const summary: DueFollowUpDraftSummary = { organizations: 0, drafted: 0, skipped: 0, failed: 0 };
  if (isMigrationControlPaused("crmFollowUpDrafts")) return summary;
  const now = options.now ?? new Date();
  // Platform-wide on purpose: this is how the job finds which organizations to visit.
  const organizations = await db
    .selectDistinct({ organizationId: crmRecords.organizationId })
    .from(crmRecords)
    .innerJoin(crmEvents, eq(crmEvents.crmRecordId, crmRecords.id))
    .where(and(dueCondition(now), sql`${crmRecords.latestInboundMessageId} is not null`));
  for (const { organizationId } of organizations) {
    summary.organizations += 1;
    try {
      await runInOrganization(organizationId, () => runOrganization(summary, now));
    } catch (error) {
      console.error(`[crm/dueFollowUpDrafts] Organization ${organizationId} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return summary;
}
