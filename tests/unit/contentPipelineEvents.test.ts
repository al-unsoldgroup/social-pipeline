/**
 * Guards the review-gate event validators against the payloads the admin
 * mutations actually send.
 *
 * `workflowManager.sendEvent` validates its `value` against the event validator
 * with `parse` before it stores the event. When the validator did not match the
 * discriminated-union payload, every approve/revise/reject click threw and no
 * article could move past a review gate. Each case below mirrors one
 * `sendEvent` call in `convex/admin/contentPipeline.ts`.
 */
import { parse } from "convex-helpers/validators";
import { describe, expect, it } from "vitest";
import {
  draftApprovalEvent,
  outlineApprovalEvent,
  researchApprovalEvent,
} from "../../convex/workflows/events";

describe("content pipeline review-gate events", () => {
  it("accepts every research decision payload", () => {
    const v = researchApprovalEvent.validator;
    expect(() =>
      parse(v, { action: "approve", selectedAngle: "The compliance angle" }),
    ).not.toThrow();
    expect(() => parse(v, { action: "revise", feedback: "Add sources" })).not.toThrow();
    expect(() => parse(v, { action: "reject", reason: "Off topic" })).not.toThrow();
  });

  it("accepts every outline decision payload", () => {
    const v = outlineApprovalEvent.validator;
    expect(() => parse(v, { action: "approve" })).not.toThrow();
    expect(() => parse(v, { action: "revise", feedback: "Reorder sections" })).not.toThrow();
    expect(() => parse(v, { action: "reject", reason: "Too shallow" })).not.toThrow();
  });

  it("accepts every draft decision payload, with and without optional fields", () => {
    const v = draftApprovalEvent.validator;
    expect(() => parse(v, { action: "approve" })).not.toThrow();
    expect(() =>
      parse(v, {
        action: "approve",
        editedContent: "Final copy",
        scheduledPublishAt: 1_700_000_000_000,
      }),
    ).not.toThrow();
    expect(() => parse(v, { action: "revise", feedback: "Tighten intro" })).not.toThrow();
    expect(() => parse(v, { action: "reject", reason: "Wrong tone" })).not.toThrow();
  });

  it("rejects the stale approved/feedback shape", () => {
    expect(() =>
      parse(researchApprovalEvent.validator, { approved: true, feedback: "" }),
    ).toThrow();
  });
});
