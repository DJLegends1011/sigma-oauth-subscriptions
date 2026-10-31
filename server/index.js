// OAuth Subscriptions (Claude Code CLI, Codex CLI & Antigravity CLI), the server half:
// Registers three native connection kinds in Project Sigma:
//   1. "claude-subscription"      -> Claude Subscription (Claude Code CLI)
//   2. "codex-subscription"       -> ChatGPT / Codex Subscription (Codex CLI)
//   3. "antigravity-subscription" -> Antigravity Subscription (Antigravity CLI)

import {
    chatClaudeCli,
    streamClaudeCli,
    listClaudeCliModels,
    claudeStatus,
} from './claude-cli.js';
import {
    chatCodexCli,
    streamCodexCli,
    listCodexCliModels,
    codexStatus,
} from './codex-cli.js';
import {
    chatAgyCli,
    streamAgyCli,
    listAgyCliModels,
    agyStatus,
} from './antigravity-cli.js';

export function register(router, ctx) {
    const { LlmError } = ctx.llm.kit;

    const dbByProfile = new Map();
    let lastDb = null;

    ctx.hooks.add('llm.request', (req, facts) => {
        if (facts?.db) {
            lastDb = facts.db;
            if (facts.profileId) dbByProfile.set(facts.profileId, facts.db);
        }
        return req;
    });

    function readSettings(profile) {
        const db = (profile?.id && dbByProfile.get(profile.id)) || lastDb;
        const defaults = {
            claudeUseResume: true,
            claudeIdentityMode: false,
            claudeFastMode: false,
            codexReasoningSummary: 'auto',
            codexVerbosity: 'medium',
            antigravityMode: 'direct',
        };
        if (!db) return defaults;
        try {
            return {
                claudeUseResume: ctx.setting(db, 'claudeUseResume') !== false,
                claudeIdentityMode: ctx.setting(db, 'claudeIdentityMode') === true,
                claudeFastMode: ctx.setting(db, 'claudeFastMode') === true,
                codexReasoningSummary: String(ctx.setting(db, 'codexReasoningSummary') || 'auto'),
                codexVerbosity: String(ctx.setting(db, 'codexVerbosity') || 'medium'),
                antigravityMode: String(ctx.setting(db, 'antigravityMode') || 'direct'),
            };
        } catch {
            return defaults;
        }
    }

    router.get('/status', async (_req, res) => {
        try {
            const [claude, codex, antigravity] = await Promise.all([
                claudeStatus(),
                codexStatus(),
                agyStatus(),
            ]);
            res.json({ claude, codex, antigravity });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    ctx.llm.registerAdapter({
        kind: 'claude-subscription',
        displayName: 'Claude Subscription (Claude Code CLI)',
        defaultBaseUrl: 'cli://claude-code',
        requiresBaseUrl: false,
        capabilities: {
            streaming: true,
            json: false,
            reasoning: true,
            vision: true,
        },
        paramTable: {
            maxTokens: 'max_tokens',
            stop: 'stop',
            reasoning: 'reasoning',
        },
        async chat(profile, req, signal) {
            return chatClaudeCli(profile, req, readSettings(profile), signal, LlmError);
        },
        async *chatStream(profile, req, signal) {
            yield* streamClaudeCli(profile, req, readSettings(profile), signal, LlmError);
        },
        async listModels() {
            return listClaudeCliModels();
        },
    });

    ctx.llm.registerAdapter({
        kind: 'codex-subscription',
        displayName: 'ChatGPT / Codex Subscription (Codex CLI)',
        defaultBaseUrl: 'cli://codex-app-server',
        requiresBaseUrl: false,
        capabilities: {
            streaming: true,
            json: false,
            reasoning: true,
            vision: true,
        },
        paramTable: {
            stop: 'stop',
            reasoning: 'reasoning',
        },
        async chat(profile, req, signal) {
            return chatCodexCli(profile, req, readSettings(profile), signal, LlmError);
        },
        async *chatStream(profile, req, signal) {
            yield* streamCodexCli(profile, req, readSettings(profile), signal, LlmError);
        },
        async listModels() {
            return listCodexCliModels();
        },
    });

    ctx.llm.registerAdapter({
        kind: 'antigravity-subscription',
        displayName: 'Antigravity Subscription (Antigravity CLI)',
        defaultBaseUrl: 'cli://antigravity',
        requiresBaseUrl: false,
        capabilities: {
            streaming: true,
            json: false,
            reasoning: true,
            vision: true,
        },
        paramTable: {
            temperature: 'temperature',
            topP: 'top_p',
            maxTokens: 'max_tokens',
            stop: 'stop',
            reasoning: 'reasoning',
        },
        async chat(profile, req, signal) {
            return chatAgyCli(profile, req, readSettings(profile), signal, LlmError);
        },
        async *chatStream(profile, req, signal) {
            yield* streamAgyCli(profile, req, readSettings(profile), signal, LlmError);
        },
        async listModels() {
            return listAgyCliModels();
        },
    });
}
