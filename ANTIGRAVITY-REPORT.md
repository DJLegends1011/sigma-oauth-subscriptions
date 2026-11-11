> Historical report. The later [source parity audit](docs/PORT-PARITY.md) corrects the earlier subprocess-isolation conclusion using Luka's full agent configuration and effective request captures.

# Antigravity integration repair — 2026-11-10

Changes are local to the development checkout. No push, release, installation sync, database change, connection migration, or Google binary modification was performed. Direct CloudCode remains the default; there is no automatic subprocess fallback.

## Findings and compatibility limits

1. **Direct CloudCode is not currently verified working for this account/client.** The installed `agy --version` reports **1.5.3**. Authenticated probes of both the existing daily endpoint and production endpoint accepted metadata requests but returned HTTP 200 generation SSE containing an unsupported-version notice as candidate text, without a terminal candidate. This occurred with the inherited `antigravity/1.5.3` header and the installed version, not a fabricated newer version. The repaired parser rejects that notice before emitting narrator text. The final implementation explicitly identifies itself as `sigma-oauth-subscriptions/1.0.0 (installed-agy/<detected version>; <platform>/<arch>)`; it does not impersonate an official client. No claim is made that a different header fixes the service restriction. The undocumented service needs Google-supported access/protocol compatibility before successful generation can be established.

2. **There is no verified documented switch that eliminates the CLI's complete coding prompt.** Google's documentation supports `--agent`, custom Markdown system prompts, tool/MCP configuration, and headless execution. It does not establish that these replace every built-in instruction or remove every tool schema. `--disable-slash-commands` disables slash-command/skill expansion, not the coding agent. A documented custom agent with `tools: []`, `mcpServers: []`, and a short system prompt was selected successfully, but its init event still advertised the CLI coding/browser tool set. Both default and custom-agent generation stopped at quota exhaustion before token accounting. No binary patch or undocumented prompt-removal switch was used. Subprocess remains an explicit compatibility fallback.

3. **Lowest verified request overhead: direct mode.** Tests inspect the serialized request and verify zero added coding/system instructions, tool definitions, MCP schemas, synthetic start messages, or continuation prompts. The supplied system prompt, role-separated history, images, samplers, stops, and applicable reasoning configuration are retained. This is verification of extension-side request content, not a successful live backend token measurement. The user's approximately 12,300-token CLI baseline was not independently reproduced: live CLI probes returned zero usage because they were rejected before generation. Total service-side prompt overhead and generation quality remain unmeasured under the current restrictions.

4. **Argon now has a separate status indicator.** It reads actual `retrieveUserQuota` model buckets and `retrieveUserQuotaSummary` group/window data. Weekly and five-hour limits, reset timestamps, explicit zero/exhaustion, missing fractions, and unavailable data are handled independently. Live metadata returned Flash/Pro and Claude/GPT data but **no Argon group or bucket**, so the correct current display is **Gemini 4 Argon: unavailable**. Mocks verify available and exhausted Argon values and UI rendering. A real Argon percentage cannot be verified until the service exposes its quota for this account/client. Metadata quota availability does not guarantee generation access: CLI generation returned a separate individual-quota rejection even while these endpoints reported remaining quota.

5. **Other restrictions:** models exposed by `agy models` differ from CloudCode's advertised model map; CLI listed Argon and Flash effort variants while CloudCode omitted Argon and those Flash IDs. The extension now discovers each mode's models separately and refuses silent cross-family substitutions. API quota buckets never become advertised generation models. A previously saved model not advertised in direct mode produces an actionable error instead of choosing another model. Existing connection IDs/settings/default mode remain intact.

## Before / after

| Area | Before | After |
|---|---|---|
| Version | First 2 KB of historical log; permanent `1.2.11` fallback | Executes installed launcher `--version`; no persistent version cache or invented version; missing detection fails clearly |
| Identity | Claimed `antigravity/<version>` | Identifies this extension and installed CLI dependency |
| Discovery | Static CLI IDs mixed into direct catalog; failures hidden | Live catalog per backend; account-scoped expiring metadata caches; discovery failures visible |
| Model resolution | Unknown/Claude/Argon IDs could become tiered Gemini | Exact advertised direct ID required; explicit error |
| Direct prompt | Added text-only preamble, placeholders, continuation instruction | Only supplied system/history/image content |
| Sampling | Inflated small max-token budgets; truncated stop list | Preserves supplied max output, temperature, top-p, stops; Gemini 3+ effort maps to thinking level; explicit thinking budgets preserved |
| SSE | Embedded errors ignored; unsupported-version text treated as prose; truncated streams succeeded | Error envelopes and known version rejection throw; multiline SSE parsed; terminal candidate required; text/reasoning/usage retained |
| CLI errors | Generic `status ERROR`; missed `result.error` and process exit | Structured errors, response fallback, `AGY_ERROR` diagnostics, HTTP/error codes, auth/quota classification, nonzero exit, signal and incomplete result handled |
| CLI prompt transport | Full transcript in command argument | Documented stream-JSON stdin avoids command-size limits |
| Quota | First Gemini and Claude model samples; no Argon | Separate three families, summary windows and bucket fallback, resets, exhausted/unavailable distinction |
| Retry behavior | Errors could look like successful narrator output | Confirmed quota errors are non-retryable; only one OAuth refresh retry for HTTP 401; no model/endpoint/subprocess auto-switch |
| Termux | Existence-only executable search | Executability checked; Node shebang/symlink resolved through Node; native Termux shell launcher preserved; explicit bad override fails clearly |

Reasoning notes: Gemini 3+ supports documented thinking levels; Gemini 2.5 uses explicit budgets rather than invented low/medium/high budget mappings. Non-Gemini model effort remains represented by the selected exact model ID. CLI headless input is documented as text-only; image input now fails clearly in that fallback rather than silently losing images. CLI output usage keeps thinking tokens as a subset of output tokens instead of double counting them. Backend acceptance of any thinking fields remains subject to the undocumented CloudCode contract and cannot be verified through the version restriction.

## Validation

Run `npm test` for offline mocked tests. Coverage includes version changes and invalid/missing executables, direct wire content and prompt overhead, images and samplers, exact models/account caches, text/reasoning/usage streaming, HTTP and SSE errors, split version rejection, multiline/malformed/interrupted streams, quota windows/families and Argon display, subprocess result/error/response/stderr/exit/abort handling, stdin transport, Node/Termux launcher resolution, inherited API-key isolation, and all three adapter registrations. Sigma's extension lint and an isolated Sigma boot/enable check also pass.

Claude and Codex adapter implementations and shared message helpers were not edited. The Antigravity registration's model-list callback now receives the existing profile/settings so its catalog matches the selected execution mode. Real Claude/Codex subscription generation was not exercised or charged. Live successful Antigravity generation, service-side token overhead, and a real Argon percentage remain blocked as described above.

The earlier standalone live diagnostic has been archived with local audit evidence. The maintained offline parity tests and isolated CLI adapter supersede it.

## Primary documentation reviewed

- [Google: headless mode, stream-JSON events, error/status and usage schema](https://antigravity.google/docs/cli/headless/)
- [Google: CLI command reference and execution flags](https://antigravity.google/docs/cli/reference/)
- [Google: custom agents, system prompts, tools and MCP configuration](https://antigravity.google/docs/subagents/)
- [Google: CLI settings](https://antigravity.google/docs/cli/using/)
- [Google: Gemini thinking configuration](https://ai.google.dev/gemini-api/docs/thinking)

The local installed CLI's `--help`, `--version`, `models` output, actual stream-JSON result/init events, and authenticated CloudCode responses were also inspected. No OAuth tokens or private account/project identifiers are included in this report.
