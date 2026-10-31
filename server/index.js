// OAuth Subscriptions (Claude Code CLI & Codex CLI), the server half:
// Registers two native connection kinds in Project Sigma:
//   1. "claude-subscription" -> Claude Subscription (Claude Code CLI)
//   2. "codex-subscription"  -> ChatGPT / Codex Subscription (Codex CLI)

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
        if (!db) {
            return {
                claudeUseResume: true,
                claudeIdentityMode: false,
                claudeFastMode: false,
                codexReasoningSummary: 'auto',
                codexVerbosity: 'medium',
            };
        }
        try {
            return {
                claudeUseResume: ctx.setting(db, 'claudeUseResume') !== false,
                claudeIdentityMode: ctx.setting(db, 'claudeIdentityMode') === true,
                claudeFastMode: ctx.setting(db, 'claudeFastMode') === true,
                codexReasoningSummary: String(ctx.setting(db, 'codexReasoningSummary') || 'auto'),
                codexVerbosity: String(ctx.setting(db, 'codexVerbosity') || 'medium'),
            };
        } catch {
            return {
                claudeUseResume: true,
                claudeIdentityMode: false,
                claudeFastMode: false,
                codexReasoningSummary: 'auto',
                codexVerbosity: 'medium',
            };
        }
    }

    router.get('/status', async (_req, res) => {
        try {
            const [claude, codex] = await Promise.all([claudeStatus(), codexStatus()]);
            res.json({ claude, codex });
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
}
