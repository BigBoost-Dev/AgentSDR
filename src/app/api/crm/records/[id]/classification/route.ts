import type { NextRequest } from "next/server";
import { crmOperationErrorResponse, requireInteger } from "@/lib/crm/api";
import { CrmConfigurationValidationError, assertExactKeys, assertObject, parseCategoryKey, parseOptionalText, parseUuid, readCrmJson } from "@/lib/crm/categories";
import { requireCrmMutationContext } from "@/lib/crm/http";
import { applyHumanClassification, changeRecordStage } from "@/lib/crm/operations";
import { STAGE_CHANGE_NEXT, STAGE_CHANGE_NOTE_MAX, type StageChangeNext } from "@/lib/crm/stageChange";
import { runInOrganization } from "@/lib/tenancy/scope";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCrmMutationContext(request);
    return await runInOrganization(ctx.organizationId, async () => {
      const value = await readCrmJson(request);
      assertObject(value);
      assertExactKeys(value, ["categoryKey", "subcategoryId", "expectedContextVersion", "classificationId", "reason", "next", "note"]);
      const input = {
        recordId: parseUuid((await params).id, "record id"),
        categoryKey: parseCategoryKey(value.categoryKey),
        subcategoryId: value.subcategoryId === null ? null : parseUuid(value.subcategoryId, "subcategoryId"),
        expectedContextVersion: requireInteger(value.expectedContextVersion, "expectedContextVersion"),
        classificationId: value.classificationId === undefined ? undefined : parseUuid(value.classificationId, "classificationId"),
        reason: parseOptionalText(value.reason, "reason", 2_000),
      };
      // The picker's confirm step sends `next` (and a note); it is routed to
      // a correction or a stage move. Accept/Keep and other callers omit it.
      if (value.next === undefined) {
        if (value.note !== undefined) throw new CrmConfigurationValidationError("note needs next");
        return Response.json(await applyHumanClassification(input));
      }
      if (!STAGE_CHANGE_NEXT.includes(value.next as StageChangeNext)) {
        throw new CrmConfigurationValidationError(`next must be one of: ${STAGE_CHANGE_NEXT.join(", ")}`);
      }
      return Response.json(await changeRecordStage({
        ...input,
        next: value.next as StageChangeNext,
        note: parseOptionalText(value.note, "note", STAGE_CHANGE_NOTE_MAX),
      }));
    });
  } catch (error) {
    return crmOperationErrorResponse(error);
  }
}
