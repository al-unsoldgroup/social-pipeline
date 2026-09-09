import type { ActionCtx } from "../_generated/server";
/**
 * Competitor Content Tagging
 *
 * Extracts structured metadata from scraped competitor pages using CF AI Gateway.
 * Uses generateObject with a Zod schema for reliable structured output.
 */

import { generateObject } from "ai";
import { z } from "zod";
import { createModelFromConfig } from "./config";

/**
 * Schema for LLM-extracted tags from competitor content
 */
export const competitorTagSchema = z.object({
  topicTag: z
    .string()
    .describe(
      "Primary topic of the page in 2-4 lowercase words, e.g. 'medical evacuation', 'trip cancellation', 'cfar insurance', 'travel insurance comparison', 'pre-existing conditions', 'cruise insurance', 'adventure sports coverage'"
    ),
  searchKeywords: z
    .array(z.string())
    .describe(
      "3-8 search keywords/phrases someone would Google to find this page"
    ),
  contentAngle: z
    .string()
    .describe("The content approach/format: comparison, explainer, guide, listicle, faq, review, news, landing, tool, current-event, provider-profile, destination-guide, or other"),
  topicCluster: z
    .string()
    .describe("The broader topic cluster using snake_case. Common values: trip_cancellation, medical_evacuation, cfar, pre_existing_conditions, adventure_travel, travel_insurance_basics, insurance_comparison, cruise_insurance, destination_specific, senior_travel, claims_process, baggage_delay, travel_medical, annual_multi_trip, group_travel, current_events, provider_info, polar_insurance, safari_insurance, expedition_cruise, operator_requirements, credit_card_vs_insurance, digital_nomad, student_travel"),
  destinations: z
    .array(z.string())
    .describe(
      "Specific destinations mentioned in lowercase: 'antarctica', 'arctic', 'africa', 'galapagos', 'europe', etc. Empty array [] if generic/no specific destination."
    ),
  contentTopics: z
    .array(z.string())
    .describe(
      "Insurance concepts covered in lowercase: 'evacuation', 'cancellation', 'pre-existing', 'cfar', 'baggage', 'delay', 'medical', 'interruption', 'rental-car', 'adventure-sports', etc."
    ),
  qualityScore: z
    .number()
    .describe(
      "Content quality rating 1-10. 1-3 = thin/generic, 4-6 = decent but standard, 7-8 = good depth/original, 9-10 = exceptional."
    ),
  summary: z
    .string()
    .describe(
      "2-3 sentence summary of what this page covers and its main takeaway."
    ),
  contentType: z
    .string()
    .describe("The type of page: blog, guide, faq, comparison, landing, tool, news, current-event, provider-profile, destination-guide, or other"),
});

export type CompetitorTags = z.infer<typeof competitorTagSchema>;

const TAGGING_SYSTEM_PROMPT = `You are a content intelligence analyst for your content publication.

Your job is to analyze scraped competitor pages and extract structured metadata. Be precise and consistent with your tagging.

Guidelines:
- topicTag should be a concise, lowercase phrase (2-4 words)
- searchKeywords should reflect what someone would Google to find this page
- qualityScore: 1-3 = thin/generic content, 4-6 = decent but standard, 7-8 = good depth/original, 9-10 = exceptional/comprehensive
- For destinations, use lowercase names: "antarctica", "arctic", "svalbard", "africa", "kenya", "tanzania", "galapagos"
- For contentTopics, use consistent terms: "evacuation", "cancellation", "cfar", "pre-existing", "medical", "baggage", "delay", "interruption"
- Focus on what makes this content strategically useful or threatening from a competitor analysis perspective`;

/**
 * Tag a single competitor page using CF AI Gateway
 */
export async function tagCompetitorContent(
  ctx: ActionCtx,
  runId: string,
  provider: "google" | "openrouter" | "workers-ai",
  modelId: string,
  pageTitle: string,
  rawMarkdown: string,
  sourceUrl: string,
  competitorName: string
): Promise<CompetitorTags> {
  const model = await createModelFromConfig(ctx, "competitor-tagger", runId, provider, modelId);

  // Truncate to stay within token budget. Kept in sync with
  // workers/tagger/src/index.ts — 5k chars is enough for this classification task.
  const maxChars = 5_000;
  const truncatedContent =
    rawMarkdown.length > maxChars
      ? rawMarkdown.slice(0, maxChars) + "\n\n[CONTENT TRUNCATED]"
      : rawMarkdown;

  const userPrompt = `Analyze this competitor page and extract structured metadata.

**Competitor:** ${competitorName}
**URL:** ${sourceUrl}
**Page Title:** ${pageTitle || "Unknown"}

**Page Content (Markdown):**
${truncatedContent}`;

  try {
    // Try generateObject first (structured output)
    const { object } = await generateObject({
      model, maxRetries: 0, maxOutputTokens: 4096,
      schema: competitorTagSchema,
      system: TAGGING_SYSTEM_PROMPT,
      prompt: userPrompt,
    });
    return object;
  } catch (structuredErr) {
    throw structuredErr;
  }
}
