import type { LeadStatus } from "./schema";

/**
 * Lead statuses in which an inbound LinkedIn message is a reply that stops outreach.
 * CONNECTED is on the list: it is the status of a lead whose accepted connection is
 * waiting out the campaign's acceptance delay, and a reply there must stop the sequence
 * (before this it was missing, so such a reply was dropped).
 *
 * WITHDRAWN is on the list too: we cancelled the invitation, so a message from that person
 * is a real reply (they wrote to us anyway) and must stop outreach.
 *
 * REQUEST_SENT is handled separately by the webhook (it may be an acceptance echo).
 */
const REPLY_STATUSES: ReadonlySet<LeadStatus> = new Set<LeadStatus>([
  "CONNECTED",
  "ACCEPT_MESSAGE_SENT",
  "FOLLOW_UP_1_SENT",
  "FOLLOW_UP_2_SENT",
  "FOLLOW_UP_3_SENT",
  "COMPLETED",
  "WITHDRAWN",
  // A thread that already has a reply keeps recording follow-up inbound messages.
  "REPLIED",
]);

export const isLinkedinReplyStatus = (status: LeadStatus): boolean => REPLY_STATUSES.has(status);

/**
 * The invitation note can arrive again as an inbound message after the connection was
 * accepted; that echo is not a reply. It can land while the lead is CONNECTED (acceptance
 * delay running) as well as after the acceptance message went out. It can also land on a
 * WITHDRAWN lead: an accept that raced our withdrawal opens the chat with our invitation note.
 * `renderedInvitation` is the campaign's invitation template with the lead's merge fields filled in.
 */
export const isLateInvitationEcho = (status: LeadStatus, renderedInvitation: string | null | undefined, messageText: string): boolean =>
  (status === "ACCEPT_MESSAGE_SENT" || status === "CONNECTED" || status === "WITHDRAWN") &&
  Boolean(renderedInvitation) &&
  messageText.trim() === (renderedInvitation as string).trim();
