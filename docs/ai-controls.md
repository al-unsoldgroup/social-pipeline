# AI controls

Every local inference request uses `convex/agents/authority.ts` and the fixed authenticated GDPR gateway route. The model catalog is discovery metadata, not permission to spend. The admin model settings page lists research, outline, draft, translation, competitor tagging, brief generation and competitor triage, including missing/blocked policies.

An administrator must save an owner, an enabled state, an approved model and positive bounded limits. Missing, disabled, incomplete or costly policies fail before provider requests. A workflow model override must equal the saved model. Changing a catalog default preserves the existing enabled state. No SDK, durable workflow or structured-output fallback retries are enabled.

The hard ceilings are 40,000 serialized outbound characters, 4,096 output tokens, 10 attempts per consumer/run, 10 attempts per consumer/minute and two concurrent requests. Administrators can lower each ceiling. Failed requests consume attempts. Workflow revisions share their workflow ID; translation and tagging batch members share a run ID. Each physical request re-reads the current policy in an atomic admission mutation and sends payload-free consumer/version/run/attempt metadata. Requests stop five seconds before the 60-second lease expires. Completed responses survive a failed cleanup mutation.

The model allowlist is Gemini 2.5 Flash, Mistral Small 3.2 and Sonar through OpenRouter's gateway-compatible route. There is no direct provider fallback. Embeddings and voice are not present in this app's source inventory.

`agents/authority:seedDisabled` only creates missing inventory and fills incomplete legacy controls as disabled. Complete operator policies and custom limits survive repeat calls. It does not activate a consumer or change an existing model. It is an internal provisioning operation, not an arbitrary table writer. No new production seed or gateway credentials are installed by this PR.

Competitor tagging processes one bounded batch per operator invocation and no longer schedules another batch. Remote tagger dispatch is locked off because its implementation and admission contract are absent from this repository. Model experiments are disabled. Scheduled publication of already-approved posts and metadata-only model catalog synchronization remain intact.

Normal deployment no longer creates a new AI gateway or overwrites the gateway name. Before rollout, verify production ownership and the existing gateway credentials, provision only the reviewed policies, and read them back through the authenticated admin settings endpoint. The repository currently has unrelated baseline compiler failures and an empty production SESSION KV placeholder; these must be resolved before merging or deploying. Existing processes or deployments were not changed by source preparation.
