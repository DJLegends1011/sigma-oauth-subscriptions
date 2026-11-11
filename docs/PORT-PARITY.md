# OAuth Subscriptions source parity audit and migration plan

Reference revision `46fe9ceaae31e6f4274d577cf222901f5b92f099` of LukaTheHero/SillyTavern-Subscriptions was fetched for this audit. The comparison uses that pinned source and the development snapshot retained in the local backup archive. The corrected code retains both existing execution-mode identifiers. The deployment now defaults fresh accounts to the isolated CLI. Explicit saved modes are honored, and accounts with existing Antigravity profiles and no saved mode are pinned to their former Direct choice through Sigma stores.

My earlier reports inferred persistent coding-agent overhead from `init.tools` and a custom agent that lacked Luka's exclusion and inheritance settings. That inference was incorrect. The upstream driver explicitly describes the missing settings and warns that `init.tools` lists the build's tool catalog. This audit and the effective-request captures supersede that conclusion.

## File-by-file comparison

| Functional reference | Earlier Sigma implementation | Local correction and retained platform adaptation |
|---|---|---|
| `lib/gemini/agy.js`, agent definition | Omitted `excludeDefaultComponents`, `inheritCustomizations` and `inheritMcp`. Ran the default CLI agent from a temporary folder. | Ported Luka's custom agent, including all three settings, `tools: []`, hidden/main-agent flags, Role/Rules prompt, per-run overflow sections and markdown heading escaping. Implementation is in `server/subscriptions-reference/gemini/agy.js`. |
| `lib/gemini/agy.js`, fallback and tool guards | Omitted private-log verification. Filtered tool text but allowed the underlying tool attempt to continue. | Ported minimum-version gate, private `--log-file` checks at init and first output, explicit fallback termination, inert-tool allowlist and rejection of other tool steps. Upstream's unknown-log warning remains a warning with the tool-step guard active. |
| `lib/gemini/agy.js`, launch and environment | Preserved Termux resolution but inherited the full process environment. Used stream-JSON stdin. | Ported text stdin, sandbox flag, slash/skill expansion disabling, environment scrubbing and billing protection. Reused Sigma's resolver in `server/agy-executable.js` to keep its Node-shebang and transactional Termux launcher behavior. The musl installer and binary are untouched. |
| `lib/gemini/agy.js`, failures and lifecycle | Reinvented event parsing, errors and cancellation. Recently added scoped SQLite cleanup. | Reused upstream event handling, watchdogs, deadline, cancellation, refusal handling and bounded CLI retry observation. Retained Sigma's structured result/error details, a terminal SUCCESS requirement, and UUID-scoped `.db`/sidecar/`.pb`/brain cleanup. Those are documented compatibility adaptations. |
| `lib/gemini/chat.js`, conversation construction | Folded through a simplified shared helper. Omitted long-input protection and agent-system spillover. | Extracted `foldConversationForAgy` verbatim into `gemini/prompt.js`, using Luka's common message helpers. Preserves the 180,000-byte stdin and 720,000-byte combined limits, system/older-history spillover, newest-turn retention and upstream truncation order. Historical images become omission markers. Current-turn images are refused as upstream requires. |
| `lib/gemini/chat.js`, completion | Omitted upstream stop scanning and prefill-echo handling for Antigravity. | Reused `CompletionWriter`, `StopScanner` and usage conversion. `server/isolated-antigravity.js` translates their completion events to Sigma's async `{text}`, `{reasoning}`, `{done}` interface. Cache and thinking details are retained. |
| `lib/gemini/chat.js`, billing and backend routing | Added Direct CloudCode and manual Google OAuth read/refresh logic. The CLI subscription route inherited potential API-key environment switches. | The corrected CLI route uses Luka's subscription-only billing guard and CLI-managed login. Existing Direct CloudCode and its credential code remain in the legacy mode pending migration. Luka's separate paid API and Auto routes are omitted here because the task requires the existing modes and Sigma already has separate API connection kinds. Full automatic overflow remains a parity gap requiring an explicit mapping decision. |
| `lib/gemini/models.js` | Reinvented tab-only CLI parsing and immediate failures. Mixed static CLI IDs with direct IDs before the earlier repair. | Reused upstream live catalog, refresh deduplication, success TTL, failed-refresh backoff, snapshot fallback, prefix stripping and effort/model validation. Sigma projects the catalog to its native model-entry shape. The CLI's own validation remains authoritative when a fallback snapshot is used. |
| `lib/gemini/status.js` | Treated a stored OAuth token as login proof and depended on CloudCode project/quota metadata. | The CLI status path now reports binary/version, billing mode, isolation support and unknown sign-in readiness until a turn authenticates. It uses Sigma's existing response fields and retains the three quota labels as unavailable where data is absent. The legacy direct status path is retained. |
| `lib/models.js`, `lib/status.js`, listener/router and panel | Replaced the combined OpenAI-compatible listener with three native Sigma adapters and one extension settings section. | Preserved the native registration, profiles, settings namespace, stream events, status route and account-context bootstrap. These replace SillyTavern transport/UI plumbing for Sigma. No extra execution mode was added. |
| `lib/claude/chat.js`, SDK loader, environment and replay modules | Uses direct Claude CLI execution instead of Luka's Agent SDK. Preserves a custom system prompt, disabled tools/settings/MCP, synthetic JSONL replay, model controls and token refresh. | Reviewed without rewriting. The raw CLI transport is a platform/dependency deviation that needs explicit maintenance justification. Upstream subscription-auth billing proof, served-model validation, the resilience ladder and optional API overflow need a dedicated parity pass. The adapter and shared Sigma message helpers retain their pre-audit bytes. |
| `lib/codex/chat.js`, app-server and configuration modules | Preserves app-server execution, ephemeral threads, user/assistant context, disabled features, tool-attempt rejection, streaming and usage. | Reviewed without rewriting. Sigma checks that a login exists, while upstream verifies `account/read` reports a ChatGPT account before subscription execution. Upstream served-model/reroute/refusal checks and explicit global-instruction-file detection need comparison with Sigma's current suppression flags. The adapter retains its pre-audit bytes. |

## CLI 1.5.3 verification

The installed Android Termux launcher reports 1.5.3. A local Gemini mock endpoint received requests from the real installed CLI using a fixture API key, a temporary HOME and the same short prompt. Both runs used `--sandbox`. This isolated the effective request construction from real account data and billing.

| Effective request component | Default agent | Luka isolated agent |
|---|---:|---:|
| System-instruction UTF-8 bytes | 18,763 | 332 |
| Compact serialized tool-schema bytes | 14,993 | 919 |
| Compact serialized conversation bytes | 493 | 493 |
| Effective function declarations | 12 | 1 (`manage_task`) |
| Private log confirmed custom agent | No custom agent selected | Yes |

The isolated system instruction contained Luka's Role and Rules sections. The default coding identity and instructions were absent from that captured payload. CLI time and model-setting metadata remained in the user content. The residual `manage_task` schema remains part of the effective request and is accepted by Luka's inert-tool guard.

These captures use the CLI's local API-provider path, so they establish request construction there. Their reported 123 input tokens are synthetic fixture data and are excluded from token-overhead claims. Raw diagnostic captures are kept in the private local audit-evidence archive outside the repository.

One real subscription request was then sent through the corrected development adapter with model `gemini-3.8-flash-medium` and prompt `Reply with exactly FLASH_OK.` It returned `FLASH_OK`, finish reason `stop`, 455 input tokens and 33 output tokens, including 30 thinking tokens. Total reported usage was 488 tokens. No conversation file remained after cleanup. This validates the installed CLI, custom agent and Sigma stream bridge using the existing subscription login. The live diagnostic record is kept in the same private local audit-evidence archive.

The earlier unisolated Sigma test reported approximately 7.1k input tokens. Its prompt and run differ from this test, so this audit makes no exact token-saving claim. The matched loopback captures supply the byte-level comparison. CLI-reported turn usage may exclude ancillary operations such as its title generation.

## Deliberate deviations from the reference

- Sigma registers native connection kinds and returns its existing stream-event types. The bridge reuses Luka's writer to preserve its stop and prefill behavior.
- The existing Sigma launcher resolver keeps Android on the transactional musl-compatible shell wrapper. The upstream generic launcher search is replaced at that boundary.
- Runtime scratch files use a process-specific OS temporary directory with a private parent directory. Long-prompt per-run agent directories and run logs retain the upstream lifecycle.
- Sigma's previously tested ephemeral conversation cleanup and structured error details remain alongside the upstream driver. Ordinary completion requires a terminal SUCCESS result.
- Source attribution, the pinned revision and the upstream AGPL-3.0 license are retained under `server/subscriptions-reference`.
- Existing Direct CloudCode code remains available as a legacy compatibility selection. It is an added Sigma architecture, with no counterpart in Luka's subscription flow. Its manual Google token refresh is redundant for CLI subscription execution.

## Deployment and migration behavior

1. Review the pinned comparison, local port, effective-request captures and offline results. The approved port is deployed with a recoverable backup.
2. Keep extension ID `oauth-subscriptions`, adapter kind `antigravity-subscription`, profile IDs, credentials, chat history and the `ext:oauth-subscriptions:*` namespace. Existing saved `cli` selections map directly to Luka's corrected isolated CLI implementation.
3. The existing CLI subscription route is the new-account default. Explicit saved `direct` and `cli` selections are honored. If an account has existing Antigravity profiles and an absent mode, the extension saves `direct` before using the new default. A fresh account saves `cli`. The mode remains an account-wide extension setting, so an explicit choice continues to govern that account’s connections.
Before migrating a direct profile, review the functional differences. The CLI uses a labelled conversation transcript, accepts text on the current turn, and resolves reasoning through model variants or effort. The upstream CLI path does not send temperature, top-p or maximum-output-token settings to a model API. Stop strings remain enforced through Luka's completion writer. A profile relying on native image inputs or API samplers needs an explicit compatibility decision.

4. Keep Direct CloudCode as a clearly marked legacy selection during the agreed transition. Remove its manual OAuth/project discovery code only after direct selections and any callers of those exported helpers have been accounted for. Both existing modes remain selectable.
5. Preserve Sigma's existing API-key connection types for paid Gemini/Vertex use. Decide separately whether Luka's Auto/API overflow should map to explicit Sigma profiles. The subscription path keeps the upstream subscription-only billing guard.
6. Deploy the reviewed working tree with a recoverable extension backup, restart the server half, and verify native registration and a tiny Flash request. Rollback restores the previous extension directory and the recorded settings snapshot if migration changed settings. The user authorized deployment and publication after reviewing this audit.
7. Address Claude/Codex parity gaps in focused changes after reviewing subscription billing and model-identity guards. Their transports can be retained where they satisfy the same contract.

## Validation and scope

All 64 offline tests passed. Sigma lint returned no findings, and an isolated Sigma instance loaded the extension and served its account-context route successfully. Seven copied shared modules were verified byte-identical to the pinned reference.

The offline suite covers the upstream flags, prompt partitioning, markdown heading protection, model/effort resolution, environment billing isolation, fallback termination, unsafe-tool rejection, split stop strings, structured failures, SQLite cleanup and the existing legacy direct tests. Sigma lint and isolated load checks are recorded with the final handoff.

The new manifest default is `cli`. Existing saved selections and profiles are preserved. Deployment verification compares configuration, chat counts and file hashes against the private backup. The final handoff records deployment and publication results.


## Pinned upstream sources

- [Antigravity driver](https://github.com/LukaTheHero/SillyTavern-Subscriptions/blob/46fe9ceaae31e6f4274d577cf222901f5b92f099/lib/gemini/agy.js)
- [Gemini chat orchestration and prompt partitioning](https://github.com/LukaTheHero/SillyTavern-Subscriptions/blob/46fe9ceaae31e6f4274d577cf222901f5b92f099/lib/gemini/chat.js)
- [Gemini model catalog](https://github.com/LukaTheHero/SillyTavern-Subscriptions/blob/46fe9ceaae31e6f4274d577cf222901f5b92f099/lib/gemini/models.js)
- [Gemini status](https://github.com/LukaTheHero/SillyTavern-Subscriptions/blob/46fe9ceaae31e6f4274d577cf222901f5b92f099/lib/gemini/status.js)
