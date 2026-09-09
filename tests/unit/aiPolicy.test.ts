import { describe, expect, it } from "vitest";
import { validatePolicy, validateRequest } from "../../convex/lib/aiPolicy";

const policy = {
  key: "draft",
  owner: "Content operations",
  provider: "openrouter",
  model: "google/gemini-2.5-flash",
  isActive: true,
  maxInputChars: 40000,
  maxOutputTokens: 4096,
  maxCalls: 4,
  maxConcurrency: 2,
  maxCallsPerMinute: 10,
  updatedAt: 1,
};
describe("authoritative AI admission", () => {
  it("requires saved enabled policy and exact approved model", () => {
    expect(() => validatePolicy(null, "draft")).toThrow();
    expect(() => validatePolicy({ ...policy, isActive: false }, "draft")).toThrow();
    for (const model of [
      "google/gemini-3.1-pro-preview",
      "anthropic/claude-sonnet-4-5",
      "perplexity/sonar-pro",
      "openrouter/google/gemini-2.5-flash",
    ]) {
      expect(() => validatePolicy({ ...policy, model }, "draft")).toThrow();
    }
    expect(validatePolicy(policy, "draft").model).toBe(policy.model);
  });
  it("rejects unbounded limits, unknown consumers and model overrides", () => {
    expect(() => validatePolicy({ ...policy, maxCalls: Number.POSITIVE_INFINITY }, "draft")).toThrow();
    expect(() => validatePolicy(policy, "unknown")).toThrow();
    expect(() =>
      validateRequest(policy, { model: "openrouter/anthropic/claude-sonnet-4-5", messages: [] }),
    ).toThrow();
    expect(() =>
      validateRequest(policy, {
        model: `openrouter/${policy.model}`,
        messages: [{ content: "x".repeat(40001) }],
      }),
    ).toThrow();
  });
});
