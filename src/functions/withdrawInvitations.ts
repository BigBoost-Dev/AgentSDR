import { isPlatformConnected } from "@/lib/platform/credentials";
import { and, asc, eq, isNotNull, isNull, lt, notExists, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaigns, connections, leads, messages } from "@/lib/linkedin/schema";
import type { LinkedInAccount } from "@/lib/linkedin/schema";
import { serializeError } from "@/lib/linkedin/serializeError";
import {
  MAX_WITHDRAW_RETRIES,
  planWithdrawal,
  selectDueWithdrawals,
  shouldStopRun,
} from "@/lib/linkedin/inviteWithdrawal";
import { withOrganizationHours } from "@/lib/linkedin/workingHours";
import { cancelInvitation, isFirstDegreeConnection, listSentInvitations } from "@/services/unipile.service";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { channelRules } from "@/lib/channels/rules.server";
import { pickInRange } from "@/lib/channels/rules";

// Withdraws connection requests that are still unaccepted after the campaign's
// "withdraw after N working days". Off (null) by default, so nothing happens unless a
// campaign sets it. Pace and size come from Settings → LinkedIn → Sending rules.
//
// The account's pending sent invitations are read once per run. A due lead that is in that
// list is cancelled by its listed id; one that is not is no longer pending, so one profile
// check tells an unrecorded accept from an invitation that is gone without one.

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Candidate rows per database read, and the most reads per run (keyset pages, oldest first). */
const CANDIDATE_BATCH = 200;
const MAX_CANDIDATE_BATCHES = 10;

type Candidate = {
  id: string;
  name: string | null;
  providerId: string | null;
  linkedinUrl: string | null;
  headline: string | null;
  profilePictureUrl: string | null;
  requestSentAt: Date | null;
  withdrawRetryCount: number;
  withdrawAfterWorkingDays: number | null;
};

/** No Connection row for this lead: an accept we already know about is the accept sweep's job. */
const noConnectionRow = () =>
  notExists(db.select({ id: connections.id }).from(connections).where(and(inOrg(connections), eq(connections.leadId, leads.id))));

export const withdrawInvitations = async (account: LinkedInAccount): Promise<void> => {
  if (!(await isPlatformConnected("unipile"))) {
    console.log("[withdrawInvitations] Unipile is not connected — skipping");
    return;
  }

  const rules = await channelRules("linkedin");
  const cap = pickInRange(rules.inviteWithdrawalsPerRun);
  // "Now" is computed here, not by the database, so the database time zone cannot shift the decision.
  const now = new Date();
  const nowIso = now.toISOString();
  const hours = withOrganizationHours(account, rules.workingHours);

  // Calendar prefilter: N working days need at least N-1 calendar days between the send
  // date and today (counted by local date, so a late-evening send can be one date older than
  // 24 h per day), so rows younger than N-2 days cannot be due. The exact test is in
  // selectDueWithdrawals. Keyset pages on (requestSentAt, id) keep not-yet-due rows at the
  // head from starving due ones behind them.
  const candidates: Candidate[] = [];
  let due: Candidate[] = [];
  let cursor: { requestSentAt: Date; id: string } | null = null;
  for (let batch = 0; batch < MAX_CANDIDATE_BATCHES; batch += 1) {
    const rows: Candidate[] = await db
      .select({
        id: leads.id,
        name: leads.name,
        providerId: leads.providerId,
        linkedinUrl: leads.linkedinUrl,
        headline: leads.headline,
        profilePictureUrl: leads.profilePictureUrl,
        requestSentAt: leads.requestSentAt,
        withdrawRetryCount: leads.withdrawRetryCount,
        withdrawAfterWorkingDays: campaigns.withdrawAfterWorkingDays,
      })
      .from(leads)
      .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(and(
        inOrg(leads),
        inOrg(campaigns),
        eq(leads.linkedinAccountId, account.id),
        eq(leads.status, "REQUEST_SENT"),
        isNull(leads.supersededByLeadId),
        isNotNull(leads.providerId),
        eq(campaigns.status, "ACTIVE"),
        isNotNull(campaigns.withdrawAfterWorkingDays),
        lt(leads.withdrawRetryCount, MAX_WITHDRAW_RETRIES),
        sql`${leads.requestSentAt} <= ${nowIso}::timestamp - greatest(${campaigns.withdrawAfterWorkingDays} - 2, 0) * interval '1 day'`,
        noConnectionRow(),
        cursor
          ? sql`(${leads.requestSentAt}, ${leads.id}) > (${cursor.requestSentAt.toISOString()}::timestamp, ${cursor.id})`
          : undefined,
      ))
      .orderBy(asc(leads.requestSentAt), asc(leads.id))
      .limit(CANDIDATE_BATCH);
    candidates.push(...rows);
    due = selectDueWithdrawals(candidates, now, hours, cap);
    if (due.length >= cap || rows.length < CANDIDATE_BATCH) break;
    const last: Candidate = rows[rows.length - 1]!;
    cursor = { requestSentAt: last.requestSentAt!, id: last.id };
  }

  if (due.length === 0) {
    console.log(`[withdrawInvitations] No invitations due for withdrawal for @${account.username}`);
    return;
  }

  // One read of the pending invitations for the whole run.
  let sent: Awaited<ReturnType<typeof listSentInvitations>>;
  try {
    sent = await listSentInvitations(account.linkedinId);
  } catch (err) {
    console.error(`[withdrawInvitations] Could not read the pending invitations of @${account.username}: ${serializeError(err)}`);
    return;
  }
  console.log(
    `[withdrawInvitations] ${due.length} invitation(s) due for @${account.username}, at most ${cap} Unipile action(s); ` +
    `${sent.byProvider.size} pending invitation(s) read (${sent.complete ? "complete" : "list incomplete"})`
  );

  const bumpRetry = (leadId: string) =>
    db.update(leads)
      .set({ withdrawRetryCount: sql`${leads.withdrawRetryCount} + 1` })
      .where(and(inOrg(leads), eq(leads.id, leadId), eq(leads.status, "REQUEST_SENT")));

  // Undo a claim, counting a retry only when asked. Guarded on WITHDRAWN so a lead the accept
  // webhook has meanwhile moved on is left alone.
  const releaseClaim = (leadId: string, countRetry: boolean) =>
    db.update(leads)
      .set({
        status: "REQUEST_SENT",
        inviteWithdrawnAt: null,
        ...(countRetry && { withdrawRetryCount: sql`${leads.withdrawRetryCount} + 1` }),
      })
      .where(and(inOrg(leads), eq(leads.id, leadId), eq(leads.status, "WITHDRAWN")));

  // Claim and commit before calling Unipile, so a crash cannot leave a withdrawn invitation
  // that still looks pending. A Connection row that appeared meanwhile blocks the claim.
  const claim = async (leadId: string): Promise<boolean> => {
    const claimed = await db
      .update(leads)
      .set({ status: "WITHDRAWN", inviteWithdrawnAt: new Date() })
      .where(and(inOrg(leads), eq(leads.id, leadId), eq(leads.status, "REQUEST_SENT"), noConnectionRow()))
      .returning({ id: leads.id });
    return claimed.length > 0;
  };

  // Every Unipile action (profile check or cancel) counts toward the cap, and they are spaced
  // by the delay between invitations: the wait happens before every action except the first.
  let actions = 0;
  const pace = async () => {
    if (actions > 0) await sleep(pickInRange(rules.inviteDelaySeconds) * 1000);
    actions += 1;
  };

  /** Claim, then cancel `invitationId`. Returns true when the run must stop. */
  const claimAndCancel = async (lead: Candidate, label: string, invitationId: string): Promise<boolean> => {
    if (!(await claim(lead.id))) {
      console.log(`[withdrawInvitations] ${label} changed state meanwhile — skipping`);
      return false;
    }
    await pace();
    try {
      const outcome = await cancelInvitation(account.linkedinId, invitationId);
      if (outcome === "cancelled") {
        console.log(`[withdrawInvitations] Withdrew ${label} (${lead.providerId})`);
      } else {
        await releaseClaim(lead.id, true);
        console.warn(`[withdrawInvitations] ${label}: the invitation vanished before it could be cancelled — left as REQUEST_SENT, retry counted`);
      }
    } catch (err) {
      const stop = shouldStopRun(err);
      console.error(`[withdrawInvitations] Cancel failed for ${label}: ${serializeError(err)}`);
      await releaseClaim(lead.id, !stop);
      if (stop) {
        console.warn(`[withdrawInvitations] Transient error or limit for @${account.username} — stopping for this run`);
        return true;
      }
    }
    return false;
  };

  for (const lead of due) {
    if (actions >= cap) break;
    const providerId = lead.providerId!; // the query requires it
    const label = lead.name ?? providerId;

    const listedId = sent.byProvider.get(providerId) ?? null;
    let storedId: string | null = null;
    if (!listedId && !sent.complete) {
      const [invitation] = await db
        .select({ linkedinMessageId: messages.linkedinMessageId })
        .from(messages)
        .where(and(inOrg(messages), eq(messages.leadId, lead.id), eq(messages.type, "INVITATION"), isNull(messages.duplicateOfMessageId)))
        .limit(1);
      storedId = invitation?.linkedinMessageId ?? null;
    }
    const plan = planWithdrawal({ listed: listedId !== null, listComplete: sent.complete, hasStoredId: storedId !== null });

    if (plan === "cancel_listed" || plan === "cancel_stored") {
      if (await claimAndCancel(lead, label, (listedId ?? storedId)!)) break;
      continue;
    }

    if (plan === "reconcile") {
      // The invitation id was never recorded and the pending list could not be read in full:
      // this is the operator-reconcile case, never marked WITHDRAWN.
      await bumpRetry(lead.id);
      console.warn(`[withdrawInvitations] ${label}: no stored invitation id and the pending list is incomplete — needs reconciliation, not withdrawn`);
      continue;
    }

    // plan === "check_profile": no longer pending. Accepted without a recorded accept, or gone by hand/declined?
    await pace();
    let firstDegree: boolean | null;
    try {
      firstDegree = await isFirstDegreeConnection(account.linkedinId, providerId);
    } catch (err) {
      const stop = shouldStopRun(err);
      console.error(`[withdrawInvitations] Could not check connection state of ${label}: ${serializeError(err)}`);
      if (stop) {
        console.warn(`[withdrawInvitations] Transient error or limit for @${account.username} — stopping for this run`);
        break;
      }
      await bumpRetry(lead.id);
      continue;
    }

    if (firstDegree === true) {
      // They accepted but no accept was recorded. Record the connection the way the
      // connection-accepted webhook does; the missedAcceptances sweep then runs the normal accept flow.
      await db
        .insert(connections)
        .values({
          organizationId: currentOrganizationId(),
          providerId,
          name: lead.name,
          headline: lead.headline,
          profilePictureUrl: lead.profilePictureUrl,
          linkedinUrl: lead.linkedinUrl,
          chatId: null,
          leadId: lead.id,
          linkedinAccountId: account.id,
          connectedAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [connections.providerId, connections.linkedinAccountId],
          set: { leadId: lead.id, updatedAt: new Date() },
        });
      console.warn(`[withdrawInvitations] ${label} is a first-degree connection with no recorded accept — Connection row created for the accept sweep`);
    } else if (firstDegree === false) {
      const marked = await db
        .update(leads)
        .set({ status: "WITHDRAWN", inviteWithdrawnAt: new Date() })
        .where(and(inOrg(leads), eq(leads.id, lead.id), eq(leads.status, "REQUEST_SENT"), noConnectionRow()))
        .returning({ id: leads.id });
      console.log(
        marked.length
          ? `[withdrawInvitations] ${label}: invitation no longer pending and not connected (withdrawn by hand or declined) — marked WITHDRAWN`
          : `[withdrawInvitations] ${label} changed state meanwhile — skipping`
      );
    } else {
      await bumpRetry(lead.id);
      console.warn(`[withdrawInvitations] ${label}: invitation not pending and connection state unknown — left as REQUEST_SENT, retry counted`);
    }
  }
};
