# Project Σ — OAuth Subscriptions Extension (`oauth-subscriptions`)

> **Status:** `v1.0.0-beta` (Private Beta)

A native LLM provider extension for **Project Σ** (`requires.api: "2.6"`) that turns your local **Claude Code CLI** (Claude Pro / Max subscription), **Codex CLI** (ChatGPT Plus / Pro / Team subscription), and **Antigravity CLI** (Google AI Pro / Ultra / Antigravity subscription) logins into first-class connection kinds in **Settings > AI**.

Zero npm dependencies are required — the extension talks directly to your installed `claude`, `codex`, and `agy` CLI binaries and OAuth credentials on the host (including Termux on Android).

---

## ✨ Features

- **Three Native Connection Kinds in Settings > AI**:
  1. **Claude Subscription (Claude Code CLI)** (`kind: "claude-subscription"`):
     - Runs `claude -p --output-format stream-json --input-format stream-json --include-partial-messages` directly.
     - **Multi-turn JSONL Session Replay (`--resume`)**: Reconstructs prior user/assistant turns into a temporary synthetic JSONL transcript so Claude receives genuine multi-turn role separation and prompt caching instead of a flattened text prompt.
     - **Automatic OAuth Token Refresh**: Reads `~/.claude/.credentials.json` (`claudeAiOauth`) and automatically refreshes expired tokens via `https://platform.claude.com/v1/oauth/token` under a file lock.
     - **Account & Roleplay Isolation**: Runs in a temporary isolated config directory with `--tools ""`, `--disable-slash-commands`, `--setting-sources ""`, `--strict-mcp-config`, `--permission-mode dontAsk`, and `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1`.
  2. **ChatGPT / Codex Subscription (Codex CLI)** (`kind: "codex-subscription"`):
     - Runs `codex app-server --stdio` (JSON-RPC 2.0 over stdio) with Termux Node script detection.
     - **Ephemeral Tool-less Threads**: Starts each turn on an ephemeral, read-only, tool-disabled thread (`features.<tool>=false`, `web_search="disabled"`, `include_environment_context=false`, MCP servers & plugins disabled).
     - **Live Model Discovery**: Queries `model/list` from the Codex app-server (with fallback to `~/.codex/models_cache.json` and built-in GPT-5.x / GPT-6 models).
  3. **Antigravity Subscription (Antigravity CLI)** (`kind: "antigravity-subscription"`):
     - Reads `~/.gemini/antigravity-cli/antigravity-oauth-token` and automatically refreshes expired Google OAuth tokens.
     - **Direct CloudCode CLI API Mode (Default)**: Calls `daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse` with the `antigravity/<version>` CLI User-Agent, bypassing the 12,300-token coding agent prompt & tool schemas while supporting full multi-turn `contents`, `systemInstruction`, samplers (`temperature`, `topP`, `maxOutputTokens`, `stopSequences`), vision (`inlineData`), and streaming thoughts (`thought: true`).
     - **Subprocess CLI Mode (`agy -p --output-format stream-json`)**: Optionally spawns `agy` in an isolated temp folder and cleans up the ephemeral conversation entry when finished.
     - **Access Both Gemini & Claude 5.5 / GPT-OSS Pools**: Lists all available models from `v1internal:fetchAvailableModels` and `agy models`.
- **Extension Settings & Live CLI Status (`Settings > Extensions > OAuth Subscriptions`)**:
  - Live status panel showing installed `claude`, `codex`, and `agy` CLI versions, login state, subscription tiers, and live quota utilization across Claude and Antigravity model pools.

---

## 📦 Installation

### Option A: Install via `.zip` in Project Σ
1. Download `oauth-subscriptions.zip` from the [Releases](../../releases) page.
2. In Project Σ, go to **Settings > Extensions > Install from file** and select `oauth-subscriptions.zip` (or extract into `extensions/installed/oauth-subscriptions`).
3. Enable **OAuth Subscriptions (Claude, Codex & Antigravity CLI)** in **Settings > Extensions**.

### Option B: Prerequisites on the Host (Termux / Linux / macOS / Windows)
- **Claude Code CLI**: Install `@anthropic-ai/claude-code` and log in once via `claude auth login`.
- **Codex CLI**: Install `@openai/codex` and log in once via `codex login`.
- **Antigravity CLI**: Install `agy` and log in once via `agy`.
- In Project Σ, go to **Settings > AI**, create a connection with Kind **Claude Subscription (Claude Code CLI)**, **ChatGPT / Codex Subscription (Codex CLI)**, or **Antigravity Subscription (Antigravity CLI)**, leave Base URL and API Key blank, and click **Fetch Models**.
