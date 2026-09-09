import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { buildGatewayBaseUrl, buildGatewayHeaders } from "../lib/aiGateway";

export type GatewayProvider = "openrouter" | "workers-ai";

import { internalQuery } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { validatePolicy } from "../lib/aiPolicy";
import { controlledTransport } from "../lib/controlledTransport";
import { readGatewayConfigFromEnv } from "../lib/aiGateway";

export const getConfig = internalQuery({ args: { key: v.string() }, handler: async (ctx, { key }) => {
  const row = await ctx.db.query("agentConfigs").withIndex("by_workspace_key", (q) => q.eq("workspaceId", undefined).eq("key", key)).unique();
  return validatePolicy(row, key);
} });

export async function createModelFromConfig(ctx: ActionCtx, key: string, runId: string, provider: string, modelId: string) {
  const policy = await ctx.runQuery(internal.agents.authority.get, { key });
  if (provider !== policy.provider || modelId !== policy.model) throw new Error("Model override differs from authoritative settings");
  const cfg = readGatewayConfigFromEnv();
  const adapter = createOpenAICompatible({
    name: "openrouter", baseURL: buildGatewayBaseUrl(cfg),
    headers: buildGatewayHeaders(cfg),
    fetch: controlledTransport(cfg, policy, {
      acquire: () => ctx.runMutation(internal.agents.authority.acquire, { key, runId, model: modelId }),
      release: (id) => ctx.runMutation(internal.agents.authority.release, { key, id }),
    }),
  });
  return adapter(`openrouter/${modelId}`);
}

// Default per-stage agent configs seeded by the init migration
export const defaultConfigs = [
  {
    key: "research",
    provider: "openrouter" as GatewayProvider,
    model: "perplexity/sonar",
    description: "Research agent — web-grounded deep research",
    createdAt: Date.now(),
  },
  {
    key: "outline",
    provider: "openrouter" as GatewayProvider,
    model: "google/gemini-2.5-flash",
    description: "Outline agent — structure and planning",
    createdAt: Date.now(),
  },
  {
    key: "draft",
    provider: "openrouter" as GatewayProvider,
    model: "google/gemini-2.5-flash",
    description: "Draft agent — full content generation",
    createdAt: Date.now(),
  },
];

// Catalog discovery is separate from admission; only these reviewed defaults are listed.
export const availableModelsSeed = defaultConfigs.map((config, order) => ({
  provider: config.provider, modelId: config.model, displayName: config.model,
  description: config.description, gatewayEndpoint: "openrouter", category: "chat" as const,
  isRecommended: false, order, createdAt: Date.now(),
}));
