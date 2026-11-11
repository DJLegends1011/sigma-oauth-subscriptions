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
    agyError,
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

    function readAntigravityMode(db, profiles) {
        const key = 'ext:oauth-subscriptions:antigravityMode';
        const saved = typeof ctx.settingValue === 'function'
            ? ctx.settingValue(db, key, null)
            : ctx.setting(db, 'antigravityMode');
        if (saved) return String(saved);

        // Preserve the previous implicit Direct selection on existing accounts.
        // A fresh account receives the isolated subscription CLI default.
        const existing = profiles || ctx.stores.llmProfiles.listProfiles(db);
        const mode = existing.some(profile => profile.kind === 'antigravity-subscription') ? 'direct' : 'cli';
        ctx.stores.settings.patchSettings(db, { [key]: mode });
        return mode;
    }

    function readSettings(profile) {
        const db = (profile?.id && dbByProfile.get(profile.id)) || lastDb;
        const defaults = {
            claudeUseResume: true,
            claudeIdentityMode: false,
            claudeFastMode: false,
            codexReasoningSummary: 'auto',
            codexVerbosity: 'medium',
            antigravityMode: 'cli',
        };
        if (!db) return defaults;
        try {
            return {
                claudeUseResume: ctx.setting(db, 'claudeUseResume') !== false,
                claudeIdentityMode: ctx.setting(db, 'claudeIdentityMode') === true,
                claudeFastMode: ctx.setting(db, 'claudeFastMode') === true,
                codexReasoningSummary: String(ctx.setting(db, 'codexReasoningSummary') || 'auto'),
                codexVerbosity: String(ctx.setting(db, 'codexVerbosity') || 'medium'),
                antigravityMode: readAntigravityMode(db),
            };
        } catch {
            return defaults;
        }
    }

    // listModels has no db in Sigma's adapter contract. Bind the asking account
    // through our own authenticated route before the page opens its model picker.
    function rememberModelContext(db) {
        const profiles = ctx.stores.llmProfiles.listProfiles(db);
        readAntigravityMode(db, profiles);
        for (const profile of profiles) {
            // A model picker for a new draft can inherit any stored profile ID.
            dbByProfile.set(profile.id, db);
        }
    }

    ctx.events?.on((records, { db }) => {
        if (records.some(record => record.entity === 'llmProfile')) rememberModelContext(db);
    });

    router.get('/model-context', (req, res) => {
        rememberModelContext(req.db);
        res.json({ ok: true });
    });

    router.get('/status', async (_req, res) => {
        rememberModelContext(_req.db);
        try {
            const [claude, codex, antigravity] = await Promise.all([
                claudeStatus(),
                codexStatus(),
                agyStatus({ antigravityMode: readAntigravityMode(_req.db) }),
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
        async listModels(profile, signal) {
            if (!profile?.id || !dbByProfile.has(profile.id)) {
                throw new LlmError('bad_request', 'Antigravity model discovery needs account context. Reload Sigma or refresh OAuth Subscriptions status, then fetch models again. API clients can GET /api/ext/oauth-subscriptions/model-context first.', { status: 400, retryable: false });
            }
            try {
                return await listAgyCliModels(profile, readSettings(profile), signal);
            } catch (err) {
                if (signal?.aborted || err?.name === 'AbortError') throw err;
                if (err?.name === 'TimeoutError') throw new LlmError('timeout', 'Antigravity model discovery timed out');
                if (err instanceof TypeError && /fetch|network/i.test(err.message)) throw new LlmError('network', `Antigravity model discovery: ${err.cause?.code || err.message}`);
                throw agyError(err?.message || err, LlmError, err?.status);
            }
        },
    });
}
