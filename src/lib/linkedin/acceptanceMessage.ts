import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { connections, leads, messages } from "@/lib/linkedin/schema";
import { deliverMessageToConnection, getChatIdForUser } from "@/services/unipile.service";
import { fillTemplate } from "@/lib/outreach/render";
import { isPersonDoNotContact } from "@/lib/crm/policies";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { acceptanceDecision } from "@/lib/linkedin/sequenceTiming";

type AcceptanceLead = {
  id: string;
  personId: string;
  linkedinUrl: string;
  acceptanceMessage: string | null;
  /** The campaign's acceptance delay in days; absent or 0 sends at once. */
  acceptanceDelayDays?: number | null;
  /** Current status and the time the accept was first handled (the delay counts from it). */
  status?: string | null;
  acceptedAt?: Date | null;
  variables: Record<string, string>;
};

type AcceptanceConnection = {
  id: string;
  providerId: string;
  chatId: string | null;
};

type AcceptanceAccount = {
  id: string;
  linkedinId: string;
};

const backfillInvitationConnection = (leadId: string, connectionId: string) =>
  db
    .update(messages)
    .set({ connectionId })
    .where(
      and(
        inOrg(messages),
        eq(messages.leadId, leadId),
        isNull(messages.connectionId),
        eq(messages.type, "INVITATION")
      )
    );

/**
 * Resolve chatId, send acceptance (or start new chat), advance lead to ACCEPT_MESSAGE_SENT.
 * With a campaign acceptance delay still running it sends nothing: the lead is parked as
 * CONNECTED ("deferred") and the missed-acceptance sweep sends it once the delay is over.
 */
export const processLeadAcceptance = async (
  lead: AcceptanceLead,
  connection: AcceptanceConnection,
  account: AcceptanceAccount,
  log: (msg: string) => void
): Promise<"sent" | "advanced" | "retry" | "blocked" | "deferred"> => {
  const delayDays = lead.acceptanceDelayDays ?? 0;
  const decision = acceptanceDecision(lead, delayDays);
  if (decision === "park") {
    // This is the moment of the accept: the delay counts from here, not from an older Connection row.
    await db
      .update(leads)
      .set({ status: "CONNECTED", acceptedAt: new Date() })
      .where(and(inOrg(leads), eq(leads.id, lead.id), eq(leads.status, "REQUEST_SENT")));
    log(`acceptance delay of ${delayDays} day(s) starts now — lead parked as CONNECTED`);
    return "deferred";
  }
  if (decision === "wait") {
    log(`acceptance delay of ${delayDays} day(s) not over yet`);
    return "deferred";
  }

  let chatId = connection.chatId;

  if (!chatId) {
    log("looking up chatId via Unipile");
    chatId = await getChatIdForUser(connection.providerId, account.linkedinId);
    if (chatId) {
      await db.update(connections).set({ chatId }).where(and(inOrg(connections), eq(connections.id, connection.id)));
      log(`chatId resolved: ${chatId}`);
    }
  }

  const acceptanceText = fillTemplate(lead.acceptanceMessage ?? "", lead.variables).trim();
  await backfillInvitationConnection(lead.id, connection.id);

  if (!acceptanceText) {
    await db
      .update(leads)
      .set({
        status: "ACCEPT_MESSAGE_SENT",
        linkedinAccountId: account.id,
        acceptMessageSentAt: new Date(),
      })
      .where(and(inOrg(leads), eq(leads.id, lead.id), inArray(leads.status, ["REQUEST_SENT", "CONNECTED"])));
    log("no acceptance message — advanced status without chat");
    return "advanced";
  }

  if (!chatId) {
    log("no existing chat — starting new chat via Unipile");
  }

  const [messageClaim] = await db.insert(messages).values({
    organizationId: currentOrganizationId(),
    type: "ACCEPTANCE",
    text: acceptanceText,
    connectionId: connection.id,
    leadId: lead.id,
    seen: true,
  }).onConflictDoNothing().returning({ id: messages.id });
  if (!messageClaim) {
    const [existingClaim] = await db.select({ providerMessageId: messages.linkedinMessageId })
      .from(messages)
      .where(and(inOrg(messages), eq(messages.leadId, lead.id), eq(messages.type, "ACCEPTANCE"), isNull(messages.duplicateOfMessageId)))
      .limit(1);
    if (!existingClaim?.providerMessageId) {
      log("acceptance has an uncertain provider outcome — reconciliation required");
      return "retry";
    }
    await db.update(leads).set({ status: "ACCEPT_MESSAGE_SENT", linkedinAccountId: account.id, acceptMessageSentAt: new Date() }).where(and(inOrg(leads), eq(leads.id, lead.id), inArray(leads.status, ["REQUEST_SENT", "CONNECTED"])));
    log("acceptance was already claimed or sent — advanced without duplicate delivery");
    return "advanced";
  }

  if (await isPersonDoNotContact(db, lead.personId)) {
    await db.transaction(async (tx) => {
      await tx.delete(messages).where(and(inOrg(messages), eq(messages.id, messageClaim.id)));
      await tx.update(leads).set({ status: "FAILED" }).where(and(inOrg(leads), eq(leads.id, lead.id), inArray(leads.status, ["REQUEST_SENT", "CONNECTED"])));
    });
    log("acceptance blocked by Person-global DNC");
    return "blocked";
  }

  let delivered: Awaited<ReturnType<typeof deliverMessageToConnection>>;
  try {
    delivered = await deliverMessageToConnection(
      connection.providerId,
      account.linkedinId,
      acceptanceText,
      chatId
    );
  } catch (error) {
    // Keep the claim because the provider may have accepted the send before
    // the transport failed. Reconciliation, not an automatic retry, decides.
    throw error;
  }

  if (!delivered.chatId) {
    return "retry";
  }

  if (delivered.chatId !== chatId) {
    chatId = delivered.chatId;
    await db.update(connections).set({ chatId }).where(and(inOrg(connections), eq(connections.id, connection.id)));
  }

  await db.update(messages).set({ linkedinMessageId: delivered.messageId }).where(and(inOrg(messages), eq(messages.id, messageClaim.id)));

  await db
    .update(leads)
    .set({
      status: "ACCEPT_MESSAGE_SENT",
      linkedinAccountId: account.id,
      acceptMessageSentAt: new Date(),
    })
    .where(and(inOrg(leads), eq(leads.id, lead.id), inArray(leads.status, ["REQUEST_SENT", "CONNECTED"])));

  log(`acceptance sent — chatId: ${chatId}`);
  return "sent";
};
