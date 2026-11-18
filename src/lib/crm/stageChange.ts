/**
 * Picking a stage in the CRM's classification picker. Pure and import-free
 * (the route, the queries and the picker's confirm step all use it).
 *
 * Two lib functions can apply a stage, and the picker is the one control for
 * both: while the AI is asking for a review of the latest reply the pick
 * corrects that reading (`applyHumanClassification`); otherwise the AI's
 * reading was right and the pick records where the deal went
 * (`moveRecordStage`).
 */
export type StageChangeNext = "reply" | "follow_up";
export const STAGE_CHANGE_NEXT: readonly StageChangeNext[] = ["reply", "follow_up"];
export const STAGE_CHANGE_NOTE_MAX = 2_000;

/** Latest reply's classification status, or null when it has none. */
export function stageChangeRoute(latestClassificationStatus: string | null): "correction" | "move" {
  return latestClassificationStatus === null
    || latestClassificationStatus === "proposed"
    || latestClassificationStatus === "failed"
    ? "correction"
    : "move";
}

/** What the confirm step preselects: draft a reply unless the rep already answered. */
export function defaultStageChangeNext(inboundAnswered: boolean): StageChangeNext {
  return inboundAnswered ? "follow_up" : "reply";
}
