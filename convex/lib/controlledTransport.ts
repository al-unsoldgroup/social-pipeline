import { buildGatewayBaseUrl, buildGatewayHeaders, type GatewayConfig } from "./aiGateway";
import { validateRequest, type Policy } from "./aiPolicy";

type Permit = { id: string; expiresAt: number; policy: Policy; runId?: string };
export function controlledTransport(
  config: GatewayConfig,
  policy: Policy,
  admission: {
    acquire: () => Promise<Permit>;
    release: (id: string) => Promise<unknown>;
  },
  transport: typeof fetch = fetch,
): typeof fetch {
  const endpoint = `${buildGatewayBaseUrl(config)}/chat/completions`;
  return async (input, init) => {
    if (String(input) !== endpoint || init?.method !== "POST" || typeof init.body !== "string")
      throw new Error("Unsupported AI transport request");
    if (init.signal?.aborted) throw new Error("AI request cancelled");
    const body: unknown = JSON.parse(init.body);
    validateRequest(policy, body);
    const permit = await admission.acquire();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    init.signal?.addEventListener("abort", cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const saved = validateRequest(permit.policy, body);
      const remainingMs = permit.expiresAt - Date.now() - 5000;
      if (remainingMs <= 0) throw new Error("AI admission expired");
      if (init.signal?.aborted) throw new Error("AI request cancelled");
      timer = setTimeout(cancel, remainingMs);
      // generateText only: buffer before releasing the shared concurrency lease.
      const inputBody = body as Record<string, unknown>;
      const requestedTokens = inputBody.max_tokens ?? inputBody.max_completion_tokens;
      const maxTokens =
        typeof requestedTokens === "number" &&
        Number.isInteger(requestedTokens) &&
        requestedTokens > 0
          ? Math.min(requestedTokens, saved.maxOutputTokens)
          : saved.maxOutputTokens;
      const payload: Record<string, unknown> = {
        ...inputBody,
        stream: false,
        max_tokens: maxTokens,
        store: false,
        provider: { data_collection: "deny", zdr: true, allow_fallbacks: false },
      };
      payload.max_completion_tokens = undefined;
      validateRequest(permit.policy, payload);
      const response = await transport(endpoint, {
        method: "POST",
        headers: {
          ...buildGatewayHeaders(config),
          "content-type": "application/json",
          "cf-aig-skip-cache": "true",
          "cf-aig-collect-log": "false",
          "cf-aig-metadata": JSON.stringify({
            app: "social-pipeline",
            environment: "unknown",
            trigger: "unknown",
            consumer: saved.key,
            version: saved.updatedAt,
            runId: permit.runId,
            attemptId: permit.id,
          }),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`AI gateway returned ${response.status}`);
      }
      const text = await response.text();
      return new Response(text, { status: response.status, headers: response.headers });
    } finally {
      if (timer) clearTimeout(timer);
      init.signal?.removeEventListener("abort", cancel);
      // A failed release must not turn a completed paid response into a retry trigger.
      // The durable lease expires within 60 seconds even if cleanup is unavailable.
      try {
        await admission.release(permit.id);
      } catch {
        /* Bounded lease expiry recovers capacity. */
      }
    }
  };
}
