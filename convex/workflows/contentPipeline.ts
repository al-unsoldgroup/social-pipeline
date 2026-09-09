/**
 * Content Pipeline Workflow
 *
 * Orchestrates the three-agent blog creation pipeline:
 * 1. Research Agent → Human Review → Approve/Revise/Reject
 * 2. Outline Agent → Human Review → Approve/Revise/Reject
 * 3. Draft Agent → Human Review → Approve/Revise/Reject → Create Blog Post
 *
 * Each stage can loop up to 3 revisions before auto-rejection.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { workflowManager } from "./index";
import {
  researchApprovalEvent,
  outlineApprovalEvent,
  draftApprovalEvent,
} from "./events";

const MAX_REVISIONS = 3;

/**
 * Helper to reject a workflow and log the error.
 * Used when an agent action throws so the status doesn't stay stuck at _in_progress.
 */
async function rejectWithError(
  step: any,
  workflowRecordId: string,
  stage: string,
  error: unknown
) {
  const reason = `Agent error: ${error instanceof Error ? error.message : String(error)}`;

  console.error("[content-pipeline] agent stage failed", {
    workflowRecordId,
    stage,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  await step.runMutation(internal.admin.contentPipeline.logFeedback, {
    id: workflowRecordId,
    stage,
    action: "reject" as const,
    feedback: reason,
  });

  await step.runMutation(internal.admin.contentPipeline.updateStatus, {
    id: workflowRecordId,
    status: "rejected",
  });

  return { status: "rejected", stage, reason };
}

// Define the content pipeline workflow
export const contentPipelineWorkflow = workflowManager.define({
  args: {
    workflowRecordId: v.id("articleWorkflows"),
    topic: v.string(),
    keywords: v.array(v.string()),
    targetAudience: v.string(),
  },
  returns: v.object({
    status: v.string(),
    stage: v.optional(v.string()),
    reason: v.optional(v.string()),
    blogPostId: v.optional(v.id("blogPosts")),
  }),

  handler: async (step, args): Promise<any> => {
    const { workflowRecordId, topic, keywords, targetAudience } = args;

    // ========================================
    // PHASE 1: RESEARCH
    // ========================================

    let researchRevisions = 0;
    let researchApproved = false;
    let selectedAngle: string | null = null;

    while (!researchApproved && researchRevisions < MAX_REVISIONS) {
      // Update status to research_in_progress
      await step.runMutation(internal.admin.contentPipeline.updateStatus, {
        id: workflowRecordId,
        status: "research_in_progress",
      });

      // Get feedback if this is a revision
      let feedback: string | undefined;
      if (researchRevisions > 0) {
        feedback = await step.runQuery(internal.admin.contentPipeline.getLastFeedback, {
          id: workflowRecordId,
          stage: "research",
        }) ?? undefined;
      }

      // Run the research agent
      let researchOutput;
      try {
        researchOutput = await step.runAction(
          internal.agents.runner.runResearch,
          {
            workflowRecordId,
            topic,
            keywords,
            targetAudience,
            feedback,
          },
          { retry: false }
        );
      } catch (error) {
        return await rejectWithError(step, workflowRecordId, "research", error);
      }

      // Save research output
      await step.runMutation(internal.admin.contentPipeline.saveResearchOutput, {
        id: workflowRecordId,
        output: researchOutput,
      });

      // Update status to research_review
      await step.runMutation(internal.admin.contentPipeline.updateStatus, {
        id: workflowRecordId,
        status: "research_review",
      });

      // Send notification for review (non-critical, don't fail workflow)
      try {
        await step.runAction(internal.notifications.sendReviewNotification, {
          workflowRecordId,
          stage: "research",
          topic,
        });
      } catch (error) {
        console.error("Failed to send research review notification:", error);
      }

      // Wait for human approval
      const researchDecision = await step.awaitEvent(researchApprovalEvent);

      // Log the feedback
      await step.runMutation(internal.admin.contentPipeline.logFeedback, {
        id: workflowRecordId,
        stage: "research",
        action: researchDecision.action,
        feedback: researchDecision.action === "revise"
          ? researchDecision.feedback
          : researchDecision.action === "reject"
          ? researchDecision.reason
          : undefined,
      });

      if (researchDecision.action === "approve") {
        researchApproved = true;
        selectedAngle = researchDecision.selectedAngle;
        await step.runMutation(internal.admin.contentPipeline.setSelectedAngle, {
          id: workflowRecordId,
          angle: selectedAngle,
        });
      } else if (researchDecision.action === "reject") {
        await step.runMutation(internal.admin.contentPipeline.updateStatus, {
          id: workflowRecordId,
          status: "rejected",
        });
        return { status: "rejected", stage: "research", reason: researchDecision.reason };
      } else {
        // Revise
        researchRevisions++;
        await step.runMutation(internal.admin.contentPipeline.incrementRevision, {
          id: workflowRecordId,
          stage: "research",
        });
      }
    }

    // Max revisions reached without approval
    if (!researchApproved) {
      await step.runMutation(internal.admin.contentPipeline.updateStatus, {
        id: workflowRecordId,
        status: "rejected",
      });
      return { status: "rejected", stage: "research", reason: "Max revisions reached" };
    }

    // ========================================
    // PHASE 2: OUTLINE
    // ========================================

    let outlineRevisions = 0;
    let outlineApproved = false;

    while (!outlineApproved && outlineRevisions < MAX_REVISIONS) {
      // Update status to outline_in_progress
      await step.runMutation(internal.admin.contentPipeline.updateStatus, {
        id: workflowRecordId,
        status: "outline_in_progress",
      });

      // Get feedback if this is a revision
      let feedback: string | undefined;
      if (outlineRevisions > 0) {
        feedback = await step.runQuery(internal.admin.contentPipeline.getLastFeedback, {
          id: workflowRecordId,
          stage: "outline",
        }) ?? undefined;
      }

      // Run the outline agent
      let outlineOutput;
      try {
        outlineOutput = await step.runAction(
          internal.agents.runner.runOutline,
          {
            workflowRecordId,
            selectedAngle: selectedAngle!,
            feedback,
          },
          { retry: false }
        );
      } catch (error) {
        return await rejectWithError(step, workflowRecordId, "outline", error);
      }

      // Save outline output
      await step.runMutation(internal.admin.contentPipeline.saveOutlineOutput, {
        id: workflowRecordId,
        output: outlineOutput,
      });

      // Update status to outline_review
      await step.runMutation(internal.admin.contentPipeline.updateStatus, {
        id: workflowRecordId,
        status: "outline_review",
      });

      // Send notification for review (non-critical)
      try {
        await step.runAction(internal.notifications.sendReviewNotification, {
          workflowRecordId,
          stage: "outline",
          topic,
        });
      } catch (error) {
        console.error("Failed to send outline review notification:", error);
      }

      // Wait for human approval
      const outlineDecision = await step.awaitEvent(outlineApprovalEvent);

      // Log the feedback
      await step.runMutation(internal.admin.contentPipeline.logFeedback, {
        id: workflowRecordId,
        stage: "outline",
        action: outlineDecision.action,
        feedback: outlineDecision.action === "revise"
          ? outlineDecision.feedback
          : outlineDecision.action === "reject"
          ? outlineDecision.reason
          : undefined,
      });

      if (outlineDecision.action === "approve") {
        outlineApproved = true;
      } else if (outlineDecision.action === "reject") {
        await step.runMutation(internal.admin.contentPipeline.updateStatus, {
          id: workflowRecordId,
          status: "rejected",
        });
        return { status: "rejected", stage: "outline", reason: outlineDecision.reason };
      } else {
        // Revise
        outlineRevisions++;
        await step.runMutation(internal.admin.contentPipeline.incrementRevision, {
          id: workflowRecordId,
          stage: "outline",
        });
      }
    }

    // Max revisions reached without approval
    if (!outlineApproved) {
      await step.runMutation(internal.admin.contentPipeline.updateStatus, {
        id: workflowRecordId,
        status: "rejected",
      });
      return { status: "rejected", stage: "outline", reason: "Max revisions reached" };
    }

    // ========================================
    // PHASE 3: DRAFT
    // ========================================

    let draftRevisions = 0;
    let draftApproved = false;
    let finalContent: string | null = null;
    let scheduledPublishAt: number | undefined;

    while (!draftApproved && draftRevisions < MAX_REVISIONS) {
      // Update status to draft_in_progress
      await step.runMutation(internal.admin.contentPipeline.updateStatus, {
        id: workflowRecordId,
        status: "draft_in_progress",
      });

      // Get feedback if this is a revision
      let feedback: string | undefined;
      if (draftRevisions > 0) {
        feedback = await step.runQuery(internal.admin.contentPipeline.getLastFeedback, {
          id: workflowRecordId,
          stage: "draft",
        }) ?? undefined;
      }

      // Run the draft agent
      let draftOutput;
      try {
        draftOutput = await step.runAction(
          internal.agents.runner.runDraft,
          {
            workflowRecordId,
            feedback,
          },
          { retry: false }
        );
      } catch (error) {
        return await rejectWithError(step, workflowRecordId, "draft", error);
      }

      // Save draft output
      await step.runMutation(internal.admin.contentPipeline.saveDraftOutput, {
        id: workflowRecordId,
        output: draftOutput,
      });

      // Update status to draft_review
      await step.runMutation(internal.admin.contentPipeline.updateStatus, {
        id: workflowRecordId,
        status: "draft_review",
      });

      // Send notification for review (non-critical)
      try {
        await step.runAction(internal.notifications.sendReviewNotification, {
          workflowRecordId,
          stage: "draft",
          topic,
        });
      } catch (error) {
        console.error("Failed to send draft review notification:", error);
      }

      // Wait for human approval
      const draftDecision = await step.awaitEvent(draftApprovalEvent);

      // Log the feedback
      await step.runMutation(internal.admin.contentPipeline.logFeedback, {
        id: workflowRecordId,
        stage: "draft",
        action: draftDecision.action,
        feedback: draftDecision.action === "revise"
          ? draftDecision.feedback
          : draftDecision.action === "reject"
          ? draftDecision.reason
          : undefined,
      });

      if (draftDecision.action === "approve") {
        draftApproved = true;
        // Use edited content if provided, otherwise use agent's content
        finalContent = draftDecision.editedContent || draftOutput.content;
        // Use admin-provided date, or fall back to calendar's scheduled date
        scheduledPublishAt = draftDecision.scheduledPublishAt;
        if (!scheduledPublishAt) {
          const wfRecord = await step.runQuery(internal.admin.contentPipeline.getWorkflow, { id: workflowRecordId });
          scheduledPublishAt = wfRecord?.scheduledPublishAt;
        }
      } else if (draftDecision.action === "reject") {
        await step.runMutation(internal.admin.contentPipeline.updateStatus, {
          id: workflowRecordId,
          status: "rejected",
        });
        return { status: "rejected", stage: "draft", reason: draftDecision.reason };
      } else {
        // Revise
        draftRevisions++;
        await step.runMutation(internal.admin.contentPipeline.incrementRevision, {
          id: workflowRecordId,
          stage: "draft",
        });
      }
    }

    // Max revisions reached without approval
    if (!draftApproved) {
      await step.runMutation(internal.admin.contentPipeline.updateStatus, {
        id: workflowRecordId,
        status: "rejected",
      });
      return { status: "rejected", stage: "draft", reason: "Max revisions reached" };
    }

    // ========================================
    // COMPLETION: Create Blog Post
    // ========================================

    const blogPostId = await step.runMutation(
      internal.admin.contentPipeline.createBlogPost,
      {
        workflowRecordId,
        finalContent: finalContent!,
        scheduledPublishAt,
      }
    );

    // Update workflow status to completed
    await step.runMutation(internal.admin.contentPipeline.updateStatus, {
      id: workflowRecordId,
      status: "completed",
    });

    // Auto-publish to the right adapter based on outputFormat. Non-fatal —
    // a failure here leaves the workflow "completed" with
    // socialPublish.status="failed"; the admin can retry via the manual
    // adapter actions (manualPublishWorkflow / manualSendNewsletter).
    try {
      const wfRecord = await step.runQuery(internal.admin.contentPipeline.getWorkflow, {
        id: workflowRecordId,
      });
      const outputFormat = wfRecord?.outputFormat ?? "blog_post";

      if (outputFormat === "newsletter_issue") {
        const resend = await step.runQuery(
          internal.admin.resendNewsletter._readResendRow,
          {},
        );
        const autoSend = (resend as { resendAutoSend?: boolean } | null)?.resendAutoSend ?? false;
        if (autoSend) {
          await step.runAction(internal.admin.resendNewsletter.sendNewsletterWorkflow, {
            workflowRecordId,
            scheduledAt: scheduledPublishAt,
          });
        }
      } else if (outputFormat === "twitter_thread" || outputFormat === "linkedin_article") {
        const zernio = await step.runQuery(
          internal.admin.zernioPublish._readZernioRow,
          {},
        );
        const autoPublish = (zernio as { zernioAutoPublish?: boolean } | null)?.zernioAutoPublish ?? false;
        if (autoPublish) {
          await step.runAction(internal.admin.zernioPublish.publishWorkflow, {
            workflowRecordId,
            scheduledAt: scheduledPublishAt,
          });
        }
      }
      // blog_post: no external publish — internal blog handles it.
    } catch (error) {
      console.error("[content-pipeline] auto-publish failed:", error);
    }

    return {
      status: "completed",
      blogPostId: blogPostId as any,
    };
  },
});
