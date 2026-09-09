import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { PipelineStep } from "./eligibility";
import { adminAction } from "../lib/adminAuth";
import type { ActionCtx } from "../_generated/server";

export const runSyncNow = adminAction({ args: {}, handler: async (ctx: ActionCtx) =>
  ctx.runAction(internal.catalog.sync.syncModelCatalog, {})
});

interface OpenRouterModel {
  id: string;
  name: string;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { modality?: string };
  top_provider?: { context_length?: number };
}

export const syncModelCatalog = internalAction({
  args: {},
  handler: async (ctx): Promise<{ synced: number; errors: number }> => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.warn("[syncModelCatalog] OPENROUTER_API_KEY not set — skipping sync");
      return { synced: 0, errors: 0 };
    }

    let models: OpenRouterModel[] = [];
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`OpenRouter API ${res.status}`);
      const data = await res.json() as { data: OpenRouterModel[] };
      models = data.data ?? [];
    } catch (err) {
      console.error("[syncModelCatalog] fetch failed", err);
      return { synced: 0, errors: 1 };
    }

    let synced = 0;
    for (const m of models) {
      if (!m.id || m.architecture?.modality?.includes("image")) continue;
      const promptPrice = parseFloat(m.pricing?.prompt ?? "0") * 1_000_000;
      const completionPrice = parseFloat(m.pricing?.completion ?? "0") * 1_000_000;
      await ctx.runMutation(internal.catalog.sync._upsertModel, {
        id: m.id,
        displayName: m.name ?? m.id,
        promptPrice,
        completionPrice,
      });
      synced++;
    }
    return { synced, errors: 0 };
  },
});

export const _upsertModel = internalMutation({
  args: {
    id: v.string(),
    displayName: v.string(),
    promptPrice: v.number(),
    completionPrice: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("modelCatalog")
      .withIndex("by_model_id", (q) => q.eq("id", args.id))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        displayName: args.displayName,
        promptPrice: args.promptPrice,
        completionPrice: args.completionPrice,
        updatedAt: now,
      });
    } else {
      const defaultFor: PipelineStep[] = [];
      await ctx.db.insert("modelCatalog", {
        id: args.id,
        displayName: args.displayName,
        isEnabled: false,
        recommendedFor: defaultFor,
        promptPrice: args.promptPrice,
        completionPrice: args.completionPrice,
        updatedAt: now,
      });
    }
  },
});
