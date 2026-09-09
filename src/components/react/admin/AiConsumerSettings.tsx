import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { CHEAP_MODELS, LIMITS, validatePolicy, type Policy } from "../../../../convex/lib/aiPolicy";

function Consumer({ consumer, policy }: { consumer: string; policy: Policy | null }) {
  const save = useMutation(api.agents.authority.save);
  const [model, setModel] = useState(policy?.model ?? CHEAP_MODELS[0]);
  const [owner, setOwner] = useState(policy?.owner ?? "");
  const [enabled, setEnabled] = useState(() => {
    try {
      validatePolicy(policy, consumer);
      return true;
    } catch {
      return false;
    }
  });
  const [message, setMessage] = useState("");
  const [limits, setLimits] = useState({
    maxCalls: policy?.maxCalls ?? LIMITS.maxCalls,
    maxCallsPerMinute: policy?.maxCallsPerMinute ?? LIMITS.maxCallsPerMinute,
    maxConcurrency: policy?.maxConcurrency ?? LIMITS.maxConcurrency,
    maxInputChars: policy?.maxInputChars ?? LIMITS.maxInputChars,
    maxOutputTokens: policy?.maxOutputTokens ?? LIMITS.maxOutputTokens,
  });
  let active = false;
  try {
    validatePolicy(policy, consumer);
    active = true;
  } catch {
    /* Invalid legacy settings remain blocked. */
  }
  return (
    <form
      className="rounded border border-slate-700 p-3 space-y-2"
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          await save({ key: consumer, owner, model, enabled, ...limits });
          setMessage("Saved");
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "Save failed");
        }
      }}
    >
      <p>
        {consumer}: {active ? "Enabled" : "Blocked"}
      </p>
      <label className="block">
        Owner{" "}
        <input
          required
          maxLength={80}
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
          className="rounded bg-slate-900 border border-slate-600 p-1"
        />
      </label>
      <select
        aria-label={`${consumer} model`}
        value={model}
        onChange={(event) => setModel(event.target.value)}
        className="bg-slate-900 border border-slate-600 rounded p-1"
      >
        {!CHEAP_MODELS.some((allowed) => allowed === model) && (
          <option value={model} disabled>
            {model} (blocked)
          </option>
        )}
        {CHEAP_MODELS.map((allowed) => (
          <option key={allowed} value={allowed}>
            {allowed}
          </option>
        ))}
      </select>
      <label className="block">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />{" "}
        Enable on save
      </label>
      {(Object.keys(limits) as Array<keyof typeof LIMITS>).map((name) => (
        <label key={name} className="block text-sm">
          {
            {
              maxCalls: "Calls per run",
              maxCallsPerMinute: "Calls per minute",
              maxConcurrency: "Concurrent calls",
              maxInputChars: "Input characters",
              maxOutputTokens: "Output tokens",
            }[name]
          }
          <input
            type="number"
            min={1}
            max={LIMITS[name]}
            step={1}
            required
            value={limits[name]}
            onChange={(event) => setLimits({ ...limits, [name]: Number(event.target.value) })}
            className="ml-2 w-24 rounded bg-slate-900 border border-slate-600 p-1"
          />
        </label>
      ))}
      <p className="text-xs text-slate-400">No retries or fallback.</p>
      <button type="submit" className="rounded border px-3 py-1">
        Save policy
      </button>
      <output className="ml-2">
        {message}
      </output>
    </form>
  );
}

export function AiConsumerSettings() {
  const inventory: { consumers: Array<{ key: string; policy: Policy | null }> } | undefined =
    useQuery(api.agents.authority.list, {});
  if (!inventory) return <p>Loading AI settings…</p>;
  return (
    <section className="space-y-3">
      <h3 className="font-semibold">All AI uses</h3>
      <p className="text-sm">
        Missing settings and costly models are blocked. Saving a model does not enable it unless
        selected below.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {inventory.consumers.map(({ key, policy }) => (
          <Consumer key={`${key}:${policy?.updatedAt}`} consumer={key} policy={policy} />
        ))}
      </div>
      <p>Remote tagger and model experiments: disabled.</p>
    </section>
  );
}
