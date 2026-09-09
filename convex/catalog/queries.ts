/**
 * Public queries + mutations for the model catalog admin UI.
 */

import { v } from "convex/values";
import { adminMutation } from "../lib/adminAuth";
import { CHEAP_MODELS } from "../lib/aiPolicy";
import {
  query,
  internalQuery,
} from "../_generated/server";

const stepLiteral = v.union(
  v.literal("research"),
  v.literal("outline"),
  v.literal("draft"),
);

export const list = query({
  args: {
    enabledOnly: v.optional(v.boolean()),
    step: v.optional(stepLiteral),
  },
  handler: async (ctx, args) => {
    const rows = args.enabledOnly
      ? await ctx.db
          .query("modelCatalog")
          .withIndex("by_enabled", (q) => q.eq("isEnabled", true))
          .collect()
      : await ctx.db.query("modelCatalog").collect();
    const filtered = args.step
      ? rows.filter((r) => r.recommendedFor.includes(args.step!))
      : rows;
    return filtered.sort((a, b) => a.id.localeCompare(b.id));
  },
});

export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    return await ctx.db
      .query("modelCatalog")
      .withIndex("by_model_id", (q) => q.eq("id", id))
      .unique();
  },
});

export const _getByIdInternal = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    return await ctx.db
      .query("modelCatalog")
      .withIndex("by_model_id", (q) => q.eq("id", id))
      .unique();
  },
});

export const setEnabled = adminMutation({
  args: { id: v.string(), isEnabled: v.boolean() },
  handler: async (ctx, { id, isEnabled }) => {
    const row = await ctx.db
      .query("modelCatalog")
      .withIndex("by_model_id", (q) => q.eq("id", id))
      .unique();
    if (!row) throw new Error(`Model ${id} not found`);
    if (isEnabled && !CHEAP_MODELS.some((model) => model === id)) throw new Error("Model blocked by cost policy");
    await ctx.db.patch(row._id, { isEnabled });
  },
});

export const setRecommendedFor = adminMutation({
  args: {
    id: v.string(),
    recommendedFor: v.array(stepLiteral),
  },
  handler: async (ctx, { id, recommendedFor }) => {
    const row = await ctx.db
      .query("modelCatalog")
      .withIndex("by_model_id", (q) => q.eq("id", id))
      .unique();
    if (!row) throw new Error(`Model ${id} not found`);
    // Guard: caller can only set steps the model is actually eligible for.
    const filtered = recommendedFor.filter((s) =>
      CHEAP_MODELS.some((model) => model === row.id) && ["research", "outline", "draft"].includes(s),
    );
    await ctx.db.patch(row._id, { recommendedFor: filtered });
  },
});

export const listAssumptions = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("pipelineCostAssumptions").collect();
  },
});

export const upsertAssumption = adminMutation({
  args: {
    step: stepLiteral,
    inputTokens: v.number(),
    outputTokens: v.number(),
    webSearches: v.optional(v.number()),
    revisions: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pipelineCostAssumptions")
      .withIndex("by_step", (q) => q.eq("step", args.step))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        webSearches: args.webSearches,
        revisions: args.revisions,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("pipelineCostAssumptions", {
        step: args.step,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        webSearches: args.webSearches,
        revisions: args.revisions,
        updatedAt: now,
      });
    }
  },
});

/**
 * Default model per pipeline step.
 *
 * Stored as rows in `agentConfigs` keyed by step name ("research" | "outline"
 * | "draft"). Provider is always "openrouter" since catalog rows are sourced
 * from OpenRouter and routed through the gateway's openrouter prefix.
 */
export const getDefaults = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("agentConfigs").collect();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const out: Record<"research" | "outline" | "draft", string | null> = {
      research: byKey.get("research")?.model ?? null,
      outline: byKey.get("outline")?.model ?? null,
      draft: byKey.get("draft")?.model ?? null,
    };
    return out;
  },
});

export const setDefaultForStep = adminMutation({
  args: { step: stepLiteral, modelId: v.string() },
  handler: async (ctx, { step, modelId }) => {
    const catalog = await ctx.db
      .query("modelCatalog")
      .withIndex("by_model_id", (q) => q.eq("id", modelId))
      .unique();
    if (!CHEAP_MODELS.some((model) => model === modelId)) throw new Error("Model blocked by cost policy");
    if (!catalog) throw new Error(`Model ${modelId} not in catalog`);
    if (!catalog.isEnabled) {
      throw new Error(`Model ${modelId} is not enabled`);
    }
    if (!catalog.recommendedFor.includes(step)) {
      throw new Error(`Model ${modelId} is not approved for ${step}`);
    }
    const existing = await ctx.db
      .query("agentConfigs")
      .withIndex("by_workspace_key", (q) => q.eq("workspaceId", undefined).eq("key", step))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        provider: "openrouter",
        model: modelId,
        isActive: existing.isActive,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("agentConfigs", {
        key: step,
        provider: "openrouter",
        model: modelId,
        isActive: false,
        updatedAt: now,
      });
    }
  },
});
