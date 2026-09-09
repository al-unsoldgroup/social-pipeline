import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { adminMutation, adminQuery } from "../lib/adminAuth";
import { CHEAP_MODELS, CONSUMERS, LIMITS, validatePolicy } from "../lib/aiPolicy";

export const list = adminQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("agentConfigs").collect();
    return {
      models: CHEAP_MODELS,
      consumers: CONSUMERS.map((key) => ({
        key,
        policy: rows.find((row) => row.key === key && row.workspaceId === undefined) ?? null,
      })),
      lockedDisabled: ["remote-tagger-worker"],
      retries: 0,
      fallback: null,
    };
  },
});
export const save = adminMutation({
  args: {
    key: v.string(),
    owner: v.string(),
    model: v.string(),
    enabled: v.boolean(),
    maxInputChars: v.number(),
    maxOutputTokens: v.number(),
    maxCalls: v.number(),
    maxConcurrency: v.number(),
    maxCallsPerMinute: v.number(),
  },
  handler: async (ctx, { enabled, ...args }) => {
    const data = { ...args, provider: "openrouter", isActive: enabled, updatedAt: Date.now() };
    validatePolicy({ ...data, isActive: true }, args.key);
    const row = await ctx.db
      .query("agentConfigs")
      .withIndex("by_workspace_key", (q) => q.eq("workspaceId", undefined).eq("key", args.key))
      .unique();
    if (row) await ctx.db.patch(row._id, data);
    else await ctx.db.insert("agentConfigs", data);
  },
});
export const get = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const row = await ctx.db
      .query("agentConfigs")
      .withIndex("by_workspace_key", (q) => q.eq("workspaceId", undefined).eq("key", key))
      .unique();
    return validatePolicy(row, key);
  },
});
export const acquire = internalMutation({
  args: { key: v.string(), runId: v.string(), model: v.string() },
  handler: async (ctx, { key, runId, model }) => {
    if (runId.length > 200) throw new Error("Invalid AI run ID");
    const policy = validatePolicy(
      await ctx.db
        .query("agentConfigs")
        .withIndex("by_workspace_key", (q) => q.eq("workspaceId", undefined).eq("key", key))
        .unique(),
      key,
    );
    if (model !== policy.model) throw new Error("AI model changed; restart with saved settings");
    const now = Date.now();
    const state = await ctx.db
      .query("aiAdmission")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    const leases = (state?.leases ?? []).filter((lease) => lease.expiresAt > now);
    const minute = Math.floor(now / 60000);
    const count = state?.minute === minute ? state.count : 0;
    const run = await ctx.db
      .query("aiRunCounts")
      .withIndex("by_run", (q) => q.eq("runId", runId).eq("key", key))
      .unique();
    if (
      leases.length >= policy.maxConcurrency ||
      count >= policy.maxCallsPerMinute ||
      (run?.count ?? 0) >= policy.maxCalls
    )
      throw new Error("AI saved budget exhausted");
    const id = crypto.randomUUID();
    const expiresAt = now + 60000;
    const data = { key, minute, count: count + 1, leases: [...leases, { id, expiresAt }] };
    if (state) await ctx.db.patch(state._id, data);
    else await ctx.db.insert("aiAdmission", data);
    if (run) await ctx.db.patch(run._id, { count: run.count + 1 });
    else await ctx.db.insert("aiRunCounts", { runId, key, count: 1 });
    return { id, expiresAt, policy, runId };
  },
});
export const release = internalMutation({
  args: { key: v.string(), id: v.string() },
  handler: async (ctx, { key, id }) => {
    const state = await ctx.db
      .query("aiAdmission")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (state)
      await ctx.db.patch(state._id, { leases: state.leases.filter((lease) => lease.id !== id) });
  },
});
// Fixed inventory only, never auto-enable a missing consumer or replace a disabled row.
export const seedDisabled = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const key of CONSUMERS) {
      const row = await ctx.db
        .query("agentConfigs")
        .withIndex("by_workspace_key", (q) => q.eq("workspaceId", undefined).eq("key", key))
        .unique();
      if (!row)
        await ctx.db.insert("agentConfigs", {
          key,
          provider: "openrouter",
          model: key === "research" ? "perplexity/sonar" : "google/gemini-2.5-flash",
          isActive: false,
          owner: "Unassigned",
          updatedAt: Date.now(),
          ...LIMITS,
        });
      else {
        // Completeness is independent of model eligibility and the enabled flag.
        // Costly models remain blocked at admission without rewriting an operator's policy.
        try {
          validatePolicy(
            { ...row, isActive: true, provider: "openrouter", model: CHEAP_MODELS[0] },
            key,
          );
          continue;
        } catch {
          /* Legacy row needs explicit controls. */
        }
        const limits = { ...LIMITS };
        for (const name of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
          const value = row[name];
          if (value !== undefined && Number.isInteger(value) && value > 0 && value <= LIMITS[name])
            limits[name] = value;
        }
        await ctx.db.patch(row._id, {
          ...limits,
          owner: row.owner?.trim() && row.owner.length <= 80 ? row.owner : "Unassigned",
          isActive: false,
          updatedAt: Date.now(),
        });
      }
    }
  },
});
