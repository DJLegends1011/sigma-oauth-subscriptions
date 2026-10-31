# Project Σ — OAuth Subscriptions Extension (`oauth-subscriptions`)

> **Status:** `v1.0.0-beta` (Private Beta)

A native LLM provider extension for **Project Σ** (`requires.api: "2.6"`) that turns your local **Claude Code CLI** (Claude Pro / Max subscription) and **Codex CLI** (ChatGPT Plus / Pro / Team subscription) logins into first-class connection kinds in **Settings > AI**.

Zero npm dependencies are required — the extension talks directly to your installed `claude` and `codex` CLI binaries on the host (including Termux on Android).

---

## ✨ Features

- **Two Native Connection Kinds in Settings > AI**:
  1. **Claude Subscription (Claude Code CLI)** (`kind: "claude-subscription"`):
     - Runs `claude -p --output-format stream-json --input-format stream-json --include-partial-messages` directly.
     - **Multi-turn JSONL Session Replay (`--resume`)**: Reconstructs prior user/assistant turns into a temporary synthetic JSONL transcript so Claude receives genuine multi-turn role separation and prompt caching instead of a flattened text prompt.
     - **Automatic OAuth Token Refresh**: Reads `~/.claude/.credentials.json` (`claudeAiOauth`) and automatically refreshes expired tokens via `https://platform.claude.com/v1/oauth/token` under a file lock. You can also paste a long-lived `claude setup-token` into the connection profile's API Key field.
     - **Account & Roleplay Isolation**: Runs in a temporary isolated config directory with `--tools ""`, `--disable-slash-commands`, `--setting-sources ""`, `--strict-mcp-config`, `--permission-mode dontAsk`, and `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` so no tools, MCP servers, CLAUDE.md files, or account identity leak into roleplay prompts.
  2. **ChatGPT / Codex Subscription (Codex CLI)** (`kind: "codex-subscription"`):
     - Runs `codex app-server --stdio` (JSON-RPC 2.0 over stdio) with Termux Node script detection.
     - **Ephemeral Tool-less Threads**: Starts each turn on an ephemeral, read-only, tool-disabled thread (`features.<tool>=false`, `web_search="disabled"`, `include_environment_context=false`, MCP servers & plugins disabled).
     - **Live Model Discovery**: Queries `model/list` from the Codex app-server (with fallback to `~/.codex/models_cache.json` and built-in GPT-5.x / GPT-6 models).
- **Streaming Thinking & Vision**:
  - Streams Claude `thinking_delta` and Codex reasoning summaries directly into Project Σ's collapsible **Thinking** block.
  - Passes base64 image attachments natively to both Claude and Codex.
- **Extension Settings & Live CLI Status (`Settings > Extensions > OAuth Subscriptions`)**:
  - Live status panel showing installed CLI versions, login state, subscription tier, and Claude OAuth quota utilization.
  - Controls for Claude multi-turn JSONL resume, account isolation, Fast Mode, Codex reasoning summaries, and Codex reply verbosity (`low` / `medium` / `high`).

---

## 📦 Installation

### Option A: Install via `.zip` in Project Σ
1. Download `oauth-subscriptions.zip` from the [Releases](../../releases) page.
2. In Project Σ, go to **Settings > Extensions > Install from file** and select `oauth-subscriptions.zip` (or extract into `extensions/installed/oauth-subscriptions`).
3. Enable **OAuth Subscriptions (Claude & Codex CLI)** in **Settings > Extensions**.

### Option B: Prerequisites on the Host (Termux / Linux / macOS / Windows)
- **Claude Code CLI**: Install `@anthropic-ai/claude-code` and log in once via `claude auth login` (or generate a token with `claude setup-token`).
- **Codex CLI**: Install `@openai/codex` and log in once via `codex login`.
- In Project Σ, go to **Settings > AI**, create a connection with Kind **Claude Subscription (Claude Code CLI)** or **ChatGPT / Codex Subscription (Codex CLI)**, leave Base URL and API Key blank (unless using an explicit token), and click **Fetch Models**.
