/**
 * Initialize default agent configs and available models.
 * This is idempotent — safe to run multiple times.
 */

import type { MutationCtx } from "../types";
import { defaultConfigs, availableModelsSeed } from "../../agents/config";

export async function handler(ctx: MutationCtx): Promise<string> {
  const now = Date.now();

  let configsInserted = 0;
  for (const config of defaultConfigs) {
    const existing = await ctx.db
      .query("agentConfigs")
      .withIndex("by_key", (q: any) => q.eq("key", config.key))
      .first();
    if (!existing) {
      await ctx.db.insert("agentConfigs", {
        ...config,
        isActive: false,
        updatedAt: now,
      });
      configsInserted++;
    }
  }

  let modelsInserted = 0;
  for (const model of availableModelsSeed) {
    const existing = await ctx.db
      .query("availableModels")
      .withIndex("by_provider_and_modelId", (q: any) =>
        q.eq("provider", model.provider).eq("modelId", model.modelId),
      )
      .first();
    if (!existing) {
      await ctx.db.insert("availableModels", {
        ...model,
        isActive: true,
        updatedAt: now,
      });
      modelsInserted++;
    }
  }

  return `Initialized ${configsInserted} agent configs and ${modelsInserted} available models`;
}
