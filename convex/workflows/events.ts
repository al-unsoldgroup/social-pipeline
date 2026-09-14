import { defineEvent } from "@convex-dev/workflow";
import { v } from "convex/values";

/**
 * Human review decisions sent from the admin gates to a suspended workflow.
 *
 * Each event is a discriminated union on `action`. `sendEvent` validates the
 * payload against the event validator, so these must match the values sent by
 * `convex/admin/contentPipeline.ts` and read by the workflow handler in
 * `./contentPipeline.ts`, or the approve/revise/reject click throws.
 */

const reviseVariant = v.object({
  action: v.literal("revise"),
  feedback: v.string(),
});

const rejectVariant = v.object({
  action: v.literal("reject"),
  reason: v.string(),
});

export const researchApprovalEvent = defineEvent({
  name: "researchApproval",
  validator: v.union(
    v.object({
      action: v.literal("approve"),
      selectedAngle: v.string(),
    }),
    reviseVariant,
    rejectVariant,
  ),
});

export const outlineApprovalEvent = defineEvent({
  name: "outlineApproval",
  validator: v.union(
    v.object({
      action: v.literal("approve"),
    }),
    reviseVariant,
    rejectVariant,
  ),
});

export const draftApprovalEvent = defineEvent({
  name: "draftApproval",
  validator: v.union(
    v.object({
      action: v.literal("approve"),
      editedContent: v.optional(v.string()),
      scheduledPublishAt: v.optional(v.number()),
    }),
    reviseVariant,
    rejectVariant,
  ),
});
