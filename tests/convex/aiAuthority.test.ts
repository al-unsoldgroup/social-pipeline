import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { api, internal } from "../../convex/_generated/api";
import { LIMITS } from "../../convex/lib/aiPolicy";

const modules = {
  "../../convex/_generated/server.ts": () => import("../../convex/_generated/server"),
  "../../convex/agents/authority.ts": () => import("../../convex/agents/authority"),
  "../../convex/lib/adminAuth.ts": () => import("../../convex/lib/adminAuth"),
};
const policy = {
  key: "draft",
  owner: "Content operations",
  provider: "openrouter",
  model: "google/gemini-2.5-flash",
  isActive: true,
  updatedAt: 1,
  ...LIMITS,
};
describe("atomic AI admission", () => {
  it("seeding preserves complete policies and custom limits on repeated runs", async () => {
    const t = convexTest(schema, modules);
    const configured = { ...policy, maxCalls: 1, maxConcurrency: 1, updatedAt: 42 };
    const id = await t.run(async (ctx) => ctx.db.insert("agentConfigs", configured));
    await t.mutation(internal.agents.authority.seedDisabled, {});
    await t.mutation(internal.agents.authority.seedDisabled, {});
    expect(await t.run(async (ctx) => ctx.db.get(id))).toMatchObject(configured);
    const rows = await t.run(async (ctx) => ctx.db.query("agentConfigs").collect());
    expect(rows).toHaveLength(7);
    expect(rows.filter((row) => row.key !== "draft").every((row) => !row.isActive)).toBe(true);
  });
  it("requires privileged policy writes and defaults missing consumers to refusal", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.agents.authority.save, {
        key: "draft",
        owner: "Content operations",
        model: policy.model,
        enabled: true,
        ...LIMITS,
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(internal.agents.authority.acquire, {
        key: "draft",
        model: policy.model,
        runId: "run",
      }),
    ).rejects.toThrow();
  });
  it("enforces shared concurrency and counts failures after release", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("agentConfigs", { ...policy, maxCalls: 2 });
    });
    const args = { key: "draft", model: policy.model, runId: "run" };
    const first = await t.mutation(internal.agents.authority.acquire, args);
    const second = await t.mutation(internal.agents.authority.acquire, args);
    await expect(
      t.mutation(internal.agents.authority.acquire, { ...args, runId: "another-run" }),
    ).rejects.toThrow("budget");
    await t.mutation(internal.agents.authority.release, { key: "draft", id: first.id });
    await t.mutation(internal.agents.authority.release, { key: "draft", id: second.id });
    await expect(t.mutation(internal.agents.authority.acquire, args)).rejects.toThrow("budget");
    await expect(
      t.mutation(internal.agents.authority.acquire, { ...args, runId: "another-run" }),
    ).resolves.toHaveProperty("id");
  });
  it("re-reads disabled state for each physical attempt", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run(async (ctx) => ctx.db.insert("agentConfigs", policy));
    const args = { key: "draft", model: policy.model, runId: "run" };
    const first = await t.mutation(internal.agents.authority.acquire, args);
    await t.mutation(internal.agents.authority.release, { key: "draft", id: first.id });
    await t.run(async (ctx) => ctx.db.patch(id, { isActive: false }));
    await expect(t.mutation(internal.agents.authority.acquire, args)).rejects.toThrow("disabled");
  });
});
