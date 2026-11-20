import { MAX_INVITATION_MESSAGE_LENGTH } from "./invitationMessage";
import {
  DEFAULT_SEQUENCE_DELAYS,
  delayLabel,
  parseSequenceDelays,
  withDefaultDelays,
  type SequenceDelayField,
  type SequenceDelays,
} from "./sequenceTiming";

export const LINKEDIN_SEQUENCE_FIELDS = [
  "invitationMessage",
  "acceptanceMessage",
  "followUp1Message",
  "followUp2Message",
  "followUp3Message",
  "followUp4Message",
] as const;

export type LinkedinSequenceField = (typeof LINKEDIN_SEQUENCE_FIELDS)[number];
export type LinkedinCampaignSequence = Record<LinkedinSequenceField, string>;

export const EMPTY_LINKEDIN_SEQUENCE: LinkedinCampaignSequence = {
  invitationMessage: "",
  acceptanceMessage: "",
  followUp1Message: "",
  followUp2Message: "",
  followUp3Message: "",
  followUp4Message: "",
};

/** The delay setting that says when each step after the connection request goes out. */
export const LINKEDIN_STEP_DELAY_FIELD: Partial<Record<LinkedinSequenceField, SequenceDelayField>> = {
  acceptanceMessage: "acceptanceDelayDays",
  followUp1Message: "followUp1DelayDays",
  followUp2Message: "followUp2DelayDays",
  followUp3Message: "followUp3DelayDays",
  followUp4Message: "followUp4DelayDays",
};

/** Messages plus timing: what the editor and the wizard hand around. */
export type LinkedinSequenceSettings = LinkedinCampaignSequence & SequenceDelays;

export type LinkedinSequenceStep = {
  field: LinkedinSequenceField;
  label: string;
  shortLabel: string;
  timing: string;
  description: string;
};

const ordinalDays = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;

/**
 * The sequence steps with timing text generated from the campaign's delays
 * (defaults: today's fixed gaps). Each delay counts from the previous step.
 */
export function linkedinSequenceSteps(input?: Partial<SequenceDelays> | null): LinkedinSequenceStep[] {
  const d = withDefaultDelays(input);
  return [
    {
      field: "invitationMessage",
      label: "Connection request",
      shortLabel: "Invitation",
      timing: "Immediately",
      description: "Sent with the connection request. Leave blank to send without a note.",
    },
    {
      field: "acceptanceMessage",
      label: "Acceptance message",
      shortLabel: "On acceptance",
      timing: d.acceptanceDelayDays > 0 ? `${ordinalDays(d.acceptanceDelayDays)} after accepted` : "When accepted",
      description:
        d.acceptanceDelayDays > 0
          ? `Sent ${ordinalDays(d.acceptanceDelayDays)} after the prospect accepts your connection request.`
          : "Sent as soon as the prospect accepts your connection request.",
    },
    {
      field: "followUp1Message",
      label: "Follow-up 1",
      shortLabel: "Follow-up 1",
      timing: delayLabel(d.followUp1DelayDays),
      description: `Sent ${ordinalDays(d.followUp1DelayDays)} after the acceptance message.`,
    },
    {
      field: "followUp2Message",
      label: "Follow-up 2",
      shortLabel: "Follow-up 2",
      timing: delayLabel(d.followUp2DelayDays),
      description: `Sent ${ordinalDays(d.followUp2DelayDays)} after follow-up 1.`,
    },
    {
      field: "followUp3Message",
      label: "Follow-up 3",
      shortLabel: "Follow-up 3",
      timing: delayLabel(d.followUp3DelayDays),
      description: `Sent ${ordinalDays(d.followUp3DelayDays)} after follow-up 2.`,
    },
    {
      field: "followUp4Message",
      label: "Follow-up 4",
      shortLabel: "Follow-up 4",
      timing: delayLabel(d.followUp4DelayDays),
      description: `Sent ${ordinalDays(d.followUp4DelayDays)} after follow-up 3, then the sequence completes.`,
    },
  ];
}

/** The steps with the default delays. */
export const LINKEDIN_SEQUENCE_STEPS: LinkedinSequenceStep[] = linkedinSequenceSteps(DEFAULT_SEQUENCE_DELAYS);

/**
 * Days after the connection is accepted at which each message goes out:
 * the acceptance message at its delay, then each follow-up that much later.
 */
export function linkedinSequenceOffsetsDays(input?: Partial<SequenceDelays> | null) {
  const d = withDefaultDelays(input);
  const acceptance = d.acceptanceDelayDays;
  const followUp1 = acceptance + d.followUp1DelayDays;
  const followUp2 = followUp1 + d.followUp2DelayDays;
  const followUp3 = followUp2 + d.followUp3DelayDays;
  const followUp4 = followUp3 + d.followUp4DelayDays;
  return { acceptance, followUp1, followUp2, followUp3, followUp4 };
}

/** Error text when a delay is missing from its range, else null. Absent values are fine. */
export function linkedinSequenceDelaysError(input: Record<string, unknown>): string | null {
  const parsed = parseSequenceDelays(input);
  return parsed.ok ? null : parsed.error;
}

export function normalizeLinkedinSequence(
  input: Partial<Record<LinkedinSequenceField, unknown>>,
): LinkedinCampaignSequence {
  return Object.fromEntries(
    LINKEDIN_SEQUENCE_FIELDS.map((field) => [
      field,
      typeof input[field] === "string" ? input[field].trim() : "",
    ]),
  ) as LinkedinCampaignSequence;
}

export function linkedinSequenceError(sequence: LinkedinCampaignSequence): string | null {
  if (sequence.invitationMessage.length > MAX_INVITATION_MESSAGE_LENGTH) {
    return `Invitation message must be ${MAX_INVITATION_MESSAGE_LENGTH} characters or fewer`;
  }

  const followUps = [sequence.followUp1Message, sequence.followUp2Message, sequence.followUp3Message, sequence.followUp4Message];
  const firstGap = followUps.findIndex((message) => !message.trim());
  if (firstGap >= 0 && followUps.slice(firstGap + 1).some((message) => message.trim())) {
    return `Add follow-up ${firstGap + 1} before adding a later follow-up`;
  }
  return null;
}
