export const CONSUMERS = [
  "research",
  "outline",
  "draft",
  "translate",
  "competitor-tagger",
  "brief-generator",
  "competitor-triage",
] as const;
export const CHEAP_MODELS = [
  "google/gemini-2.5-flash",
  "mistralai/mistral-small-3.2-24b-instruct",
  "perplexity/sonar",
] as const;
export type Policy = {
  key: string;
  provider: string;
  model: string;
  isActive: boolean;
  owner?: string;
  maxInputChars?: number;
  maxOutputTokens?: number;
  maxCalls?: number;
  maxConcurrency?: number;
  maxCallsPerMinute?: number;
  updatedAt: number;
};
export const LIMITS = {
  maxInputChars: 40000,
  maxOutputTokens: 4096,
  maxCalls: 10,
  maxConcurrency: 2,
  maxCallsPerMinute: 10,
};
export function validatePolicy(row: Policy | null, key: string) {
  if (
    !CONSUMERS.some((consumer) => consumer === key) ||
    !row ||
    row.key !== key ||
    row.isActive !== true
  )
    throw new Error("AI consumer missing or disabled");
  if (row.provider !== "openrouter" || !CHEAP_MODELS.some((model) => model === row.model))
    throw new Error("AI model blocked by cost policy");
  if (!row.owner?.trim() || row.owner.length > 80) throw new Error("AI owner missing or invalid");
  const limits = { ...LIMITS };
  for (const name of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    const value = row[name];
    if (value === undefined || !Number.isInteger(value) || value < 1 || value > LIMITS[name])
      throw new Error(`AI limit missing or invalid: ${name}`);
    limits[name] = value;
  }
  return { ...row, ...limits };
}
export function validateRequest(policy: Policy, body: unknown) {
  const saved = validatePolicy(policy, policy.key);
  if (
    !body ||
    typeof body !== "object" ||
    !("model" in body) ||
    body.model !== `openrouter/${saved.model}`
  )
    throw new Error("AI model override refused");
  if (JSON.stringify(body).length > saved.maxInputChars)
    throw new Error("AI input exceeds saved limit");
  return saved;
}
