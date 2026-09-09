import { describe, expect, it, vi } from "vitest";
import { controlledTransport } from "../../convex/lib/controlledTransport";
import { LIMITS } from "../../convex/lib/aiPolicy";

const cfg = {
  accountId: "4258f4cfefdfa4b58babec3d92e3c232",
  gatewayName: "gdpr",
  token: "test-only-token-not-a-secret",
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
const url = `https://gateway.ai.cloudflare.com/v1/${cfg.accountId}/gdpr/compat/chat/completions`;
const init = {
  method: "POST",
  body: JSON.stringify({
    model: `openrouter/${policy.model}`,
    messages: [{ role: "user", content: "fixture" }],
    max_tokens: 99999,
  }),
};
function setup(overrides = {}) {
  const acquire = vi.fn(async () => ({
    id: "lease",
    runId: "run",
    expiresAt: Date.now() + 10000,
    policy,
    ...overrides,
  }));
  const release = vi.fn(async () => {});
  const http = vi.fn<typeof fetch>(async () => new Response('{"choices":[]}'));
  return {
    acquire,
    release,
    http,
    run: controlledTransport(cfg, policy, { acquire, release }, http),
  };
}
describe("final inference transport", () => {
  it("pins route, authentication, output and one physical attempt", async () => {
    const t = setup();
    await t.run(url, init);
    expect(t.http).toHaveBeenCalledTimes(1);
    const request = t.http.mock.calls[0][1]!;
    expect(request.redirect).toBe("error");
    expect(JSON.parse(String(request.body)).max_tokens).toBe(4096);
    expect(new Headers(request.headers).get("cf-aig-authorization")).toBe(`Bearer ${cfg.token}`);
    expect(JSON.parse(new Headers(request.headers).get("cf-aig-metadata")!)).toEqual({
      app: "social-pipeline",
      environment: "unknown",
      trigger: "unknown",
      consumer: "draft",
      version: 1,
      runId: "run",
      attemptId: "lease",
    });
    expect(t.release).toHaveBeenCalledWith("lease");
  });
  it("refuses missing gateway, wrong account and direct provider before HTTP", async () => {
    const t = setup();
    await expect(t.run("https://openrouter.ai/api/v1/chat/completions", init)).rejects.toThrow();
    expect(() => controlledTransport({ ...cfg, token: "" }, policy, t, t.http)).toThrow();
    expect(() =>
      controlledTransport({ ...cfg, accountId: "0".repeat(32) }, policy, t, t.http),
    ).toThrow();
    expect(t.http).not.toHaveBeenCalled();
  });
  it("refuses disabled, expired and changed policies before HTTP", async () => {
    for (const overrides of [
      { expiresAt: 1 },
      { policy: { ...policy, isActive: false } },
      { policy: { ...policy, model: "perplexity/sonar-pro" } },
    ]) {
      const t = setup(overrides);
      await expect(t.run(url, init)).rejects.toThrow();
      expect(t.http).not.toHaveBeenCalled();
      expect(t.release).toHaveBeenCalledOnce();
    }
  });
  it("never retries a failed gateway request", async () => {
    const t = setup();
    t.http.mockResolvedValue(new Response("failed", { status: 429 }));
    await expect(t.run(url, init)).rejects.toThrow("429");
    expect(t.http).toHaveBeenCalledOnce();
    expect(t.release).toHaveBeenCalledOnce();
  });
  it("counts the complete outbound payload against the input limit", async () => {
    const limited = { ...policy, maxInputChars: init.body.length + 1 };
    const t = setup({ policy: limited });
    await expect(t.run(url, init)).rejects.toThrow("input");
    expect(t.http).not.toHaveBeenCalled();
  });
  it("preserves the completed result if lease release fails", async () => {
    const t = setup();
    t.release.mockRejectedValue(new Error("database unavailable"));
    const result = await t.run(url, init);
    expect(await result.text()).toBe('{"choices":[]}');
    expect(t.http).toHaveBeenCalledOnce();
  });
  it("forwards caller cancellation and stops before lease expiry", async () => {
    const t = setup();
    const controller = new AbortController();
    t.http.mockImplementation(async (_input, request) => {
      controller.abort();
      expect(request?.signal?.aborted).toBe(true);
      throw new Error("cancelled");
    });
    await expect(t.run(url, { ...init, signal: controller.signal })).rejects.toThrow("cancelled");
    const nearlyExpired = setup({ expiresAt: Date.now() + 4000 });
    await expect(nearlyExpired.run(url, init)).rejects.toThrow("expired");
    expect(nearlyExpired.http).not.toHaveBeenCalled();
  });
});
