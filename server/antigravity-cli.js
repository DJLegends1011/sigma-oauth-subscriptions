// Antigravity CLI (`agy`) & CloudCode OAuth Subscription adapter for Project Sigma.
// Supports both:
//   - "direct" mode (default): Calls `daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`
//     with the Antigravity CLI User-Agent and OAuth token from `~/.gemini/antigravity-cli/antigravity-oauth-token`
//     for pure roleplay multi-turn chats (zero 12k coding-agent prompt overhead, full sampler & vision support).
//   - "cli" mode: Spawns `agy --output-format stream-json --disable-slash-commands -p=...` in an isolated temp dir
//     and cleans up the ephemeral conversation entry when done.

import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import {
    existsSync,
    readFileSync,
    writeFileSync,
    renameSync,
    mkdirSync,
    rmSync,
    chmodSync,
    unlinkSync,
} from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TEXT_ONLY_PREAMBLE, partitionMessages, foldConversation } from './messages.js';

const CLOUDCODE_BASE = 'https://daily-cloudcode-pa.googleapis.com/v1internal';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AGY_CLIENT_ID = '***REMOVED***';
const AGY_CLIENT_SECRET = '***REMOVED***';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

const STATIC_AGY_CLI_MODELS = [
    { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
    { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
    { id: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
    { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
    { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
    { id: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' },
    { id: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
    { id: 'claude-sonnet-5-5-high', name: 'Claude Sonnet 5.5 (High)' },
    { id: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5 (Medium)' },
    { id: 'claude-sonnet-5-5-low', name: 'Claude Sonnet 5.5 (Low)' },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
];

let cachedVersion = null;
let cachedProject = null;
let cachedTierName = null;
let modelCache = { at: 0, models: null, rawMap: null, tieredIds: null, cliIds: null };

export function resolveAgyBinary() {
    const h = homedir();
    const isWin = process.platform === 'win32';
    const binName = isWin ? 'agy.exe' : 'agy';
    const candidates = [
        process.env.AGY_PATH,
        '/data/data/com.termux/files/usr/bin/agy',
        join(h, 'agy-termux-musl', 'agy'),
        join(h, '.local', 'bin', binName),
        join(h, '.antigravity', 'bin', binName),
        '/usr/local/bin/agy',
        '/opt/homebrew/bin/agy',
        isWin && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'agy.exe') : null,
        ...String(process.env.PATH || '')
            .split(delimiter)
            .filter(Boolean)
            .map(dir => join(dir, binName)),
    ].filter(Boolean);

    for (const c of candidates) {
        if (existsSync(c)) return { command: c, path: c };
    }
    return null;
}

export function detectAgyVersion() {
    if (cachedVersion) return cachedVersion;
    try {
        const logHead = readFileSync(join(agyDataDir(), 'cli.log'), 'utf8').slice(0, 2048);
        const m = logHead.match(/Language server version:\s*(\d+\.\d+\.\d+)/i);
        if (m) {
            cachedVersion = m[1];
            return cachedVersion;
        }
    } catch { /* ignore */ }
    cachedVersion = '1.2.11';
    return cachedVersion;
}

function agyUserAgent() {
    const ver = detectAgyVersion() || '1.2.11';
    return `antigravity/${ver} ${process.platform}/${process.arch}`;
}

export function agyDataDir() {
    return process.env.AGY_DATA_DIR || join(homedir(), '.gemini', 'antigravity-cli');
}

function tokenFilePath() {
    return join(agyDataDir(), 'antigravity-oauth-token');
}

export function readAgyStoredToken() {
    try {
        const raw = JSON.parse(readFileSync(tokenFilePath(), 'utf8'));
        const tok = typeof raw.token === 'string' ? JSON.parse(raw.token) : raw.token;
        let email = null;
        if (typeof raw.id_token === 'string') {
            try {
                const payload = JSON.parse(Buffer.from(raw.id_token.split('.')[1], 'base64url').toString('utf8'));
                email = payload.email || null;
            } catch { /* ignore */ }
        }
        return {
            raw,
            accessToken: tok?.access_token ?? null,
            refreshToken: tok?.refresh_token ?? null,
            expiryMs: tok?.expiry ? Date.parse(tok.expiry) || 0 : 0,
            email,
        };
    } catch {
        return null;
    }
}

let inflightRefresh = null;

export function refreshAgyOAuthToken() {
    if (inflightRefresh) return inflightRefresh;
    inflightRefresh = (async () => {
        const stored = readAgyStoredToken();
        if (!stored?.refreshToken) return false;
        try {
            const res = await fetch(GOOGLE_TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: AGY_CLIENT_ID,
                    client_secret: AGY_CLIENT_SECRET,
                    refresh_token: stored.refreshToken,
                    grant_type: 'refresh_token',
                }),
                signal: AbortSignal.timeout(15000),
            });
            if (!res.ok) return false;
            const data = await res.json();
            if (!data.access_token) return false;

            const path = tokenFilePath();
            const latest = readAgyStoredToken() ?? stored;
            const inner = typeof latest.raw.token === 'string' ? JSON.parse(latest.raw.token) : { ...latest.raw.token };
            inner.access_token = data.access_token;
            if (data.refresh_token) inner.refresh_token = data.refresh_token;
            const expDate = new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000);
            inner.expiry = expDate.toISOString();

            const updated = {
                ...latest.raw,
                token: JSON.stringify(inner),
                ...(data.id_token ? { id_token: data.id_token } : {}),
            };
            const tmp = `${path}.${process.pid}.tmp`;
            try {
                writeFileSync(tmp, JSON.stringify(updated), { mode: 0o600 });
                renameSync(tmp, path);
                try { chmodSync(path, 0o600); } catch { /* ignore */ }
            } finally {
                try { unlinkSync(tmp); } catch { /* ignore */ }
            }
            return true;
        } catch {
            return false;
        }
    })().finally(() => {
        inflightRefresh = null;
    });
    return inflightRefresh;
}

export async function getAgyAuthToken(profile) {
    // Only honor profile.api_key if it is explicitly a Google OAuth2 access token (`ya29....`).
    // Project Sigma's `resolveDraft` inherits `profile.api_key` from the default/base profile
    // when testing a draft connection with an empty API key input, which would otherwise pass
    // an OpenRouter or GLM key here.
    const profileKey = String(profile?.api_key ?? '').trim();
    if (/^ya29\.[A-Za-z0-9._-]+$/.test(profileKey)) {
        return { source: 'profile', accessToken: profileKey };
    }
    let stored = readAgyStoredToken();
    if (!stored?.accessToken) return null;
    if ((!stored.expiryMs || stored.expiryMs - Date.now() < REFRESH_MARGIN_MS) && stored.refreshToken) {
        await refreshAgyOAuthToken();
        stored = readAgyStoredToken() ?? stored;
    }
    return {
        source: 'file',
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
        expiryMs: stored.expiryMs,
        email: stored.email,
    };
}

async function resolveProjectAndTier(accessToken) {
    if (cachedProject) return { project: cachedProject, tierName: cachedTierName };
    try {
        const res = await fetch(`${CLOUDCODE_BASE}:loadCodeAssist`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'User-Agent': agyUserAgent(),
            },
            body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
            signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
            const data = await res.json();
            if (data.cloudaicompanionProject) cachedProject = data.cloudaicompanionProject;
            cachedTierName = data.paidTier?.name || data.currentTier?.name || 'Antigravity';
        }
    } catch { /* fall back below */ }
    if (!cachedProject) {
        try {
            cachedProject = readFileSync(join(agyDataDir(), 'cache', 'default_project_id.txt'), 'utf8').trim();
        } catch { /* ignore */ }
    }
    return {
        project: cachedProject || 'aicode-consumers',
        tierName: cachedTierName || 'Antigravity',
    };
}

export async function discoverAgyModels({ force = false } = {}) {
    if (!force && modelCache.models && Date.now() - modelCache.at < MODEL_CACHE_TTL_MS) {
        return modelCache;
    }

    const auth = await getAgyAuthToken();
    const byId = new Map();
    let rawMap = {};
    let tieredIds = {};

    if (auth?.accessToken) {
        try {
            const { project } = await resolveProjectAndTier(auth.accessToken);
            const res = await fetch(`${CLOUDCODE_BASE}:fetchAvailableModels`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${auth.accessToken}`,
                    'Content-Type': 'application/json',
                    'User-Agent': agyUserAgent(),
                },
                body: JSON.stringify({ project }),
                signal: AbortSignal.timeout(12000),
            });
            if (res.ok) {
                const data = await res.json();
                rawMap = data.models || {};
                tieredIds = data.tieredModelIds || {};
                for (const [id, m] of Object.entries(rawMap)) {
                    if (/^(chat_|tab_)/.test(id)) continue;
                    byId.set(id, {
                        id,
                        contextLength: Number(m.maxTokens) || 1000000,
                        vision: m.supportsImages !== false,
                        quotaInfo: m.quotaInfo || null,
                        displayName: m.displayName || id,
                    });
                }
            }
        } catch { /* fall back to static CLI list */ }
    }

    const cliIds = new Set(STATIC_AGY_CLI_MODELS.map(m => m.id));
    for (const cm of STATIC_AGY_CLI_MODELS) {
        if (!byId.has(cm.id)) {
            byId.set(cm.id, {
                id: cm.id,
                contextLength: 1000000,
                vision: true,
                displayName: cm.name,
            });
        }
    }

    const models = [...byId.values()];
    modelCache = { at: Date.now(), models, rawMap, tieredIds, cliIds };
    return modelCache;
}

export async function listAgyCliModels() {
    const { models } = await discoverAgyModels();
    return models.map(({ id, contextLength, vision }) => ({ id, contextLength, vision }));
}

function resolveCloudCodeModel(requestedId, cache) {
    const raw = String(requestedId || '').trim();
    if (!raw) return 'gemini-2.5-pro';
    if (cache?.rawMap && cache.rawMap[raw]) return raw;
    const tieredPro = cache?.tieredIds?.pro?.[0];
    const tieredFlash = cache?.tieredIds?.flash?.[0];
    const tieredLite = cache?.tieredIds?.flashLite?.[0];
    if (/lite/i.test(raw) && tieredLite) return tieredLite;
    if (/flash/i.test(raw) && tieredFlash) return tieredFlash;
    if (tieredPro) return tieredPro;
    const firstKey = cache?.rawMap ? Object.keys(cache.rawMap).find(k => !/^(chat_|tab_)/.test(k)) : null;
    return firstKey || raw;
}

function buildCloudCodeContents(turns) {
    const contents = [];
    for (const t of turns) {
        const role = t.role === 'assistant' ? 'model' : 'user';
        const parts = [];
        if (Array.isArray(t.images)) {
            for (const img of t.images) {
                if (img.data && img.mediaType) {
                    parts.push({
                        inlineData: {
                            mimeType: img.mediaType,
                            data: img.data,
                        },
                    });
                }
            }
        }
        if (t.text) parts.push({ text: t.text });
        if (!parts.length) parts.push({ text: '[...]' });

        const prev = contents[contents.length - 1];
        if (prev && prev.role === role) {
            prev.parts.push(...parts);
        } else {
            contents.push({ role, parts });
        }
    }
    if (!contents.length) {
        contents.push({ role: 'user', parts: [{ text: '[Start]' }] });
    } else if (contents[contents.length - 1].role === 'model') {
        contents.push({
            role: 'user',
            parts: [{ text: '[Continue your last message — write only what comes next.]' }],
        });
    }
    return contents;
}

async function* streamAgyDirect(profile, req, signal, LlmError, retriedAuth = false) {
    const auth = await getAgyAuthToken(profile);
    if (!auth?.accessToken) {
        throw new LlmError('auth', 'No Antigravity OAuth login found in `~/.gemini/antigravity-cli/antigravity-oauth-token`. Run `agy` to sign in.', {
            status: 401,
            retryable: false,
        });
    }

    const cache = await discoverAgyModels();
    const { project } = await resolveProjectAndTier(auth.accessToken);
    const requestedModel = req.model || profile.model || 'claude-sonnet-5-5-medium';
    const targetModel = resolveCloudCodeModel(requestedModel, cache);

    const { system, turns } = partitionMessages(req.messages || []);
    const sysText = system ? `${system}\n\n${TEXT_ONLY_PREAMBLE}` : TEXT_ONLY_PREAMBLE;
    const contents = buildCloudCodeContents(turns);

    const wantsThinking = Boolean(req.params?.reasoning || /-(low|medium|high)$/i.test(requestedModel) || /thinking/i.test(targetModel));
    const requestedMax = Number(req.params?.maxTokens) || 8192;
    const generationConfig = {
        maxOutputTokens: wantsThinking ? Math.max(2048, requestedMax) : Math.max(256, requestedMax),
    };
    if (typeof req.params?.temperature === 'number') generationConfig.temperature = req.params.temperature;
    if (typeof req.params?.topP === 'number') generationConfig.topP = req.params.topP;
    if (Array.isArray(req.params?.stop) && req.params.stop.length > 0) {
        generationConfig.stopSequences = req.params.stop.slice(0, 4);
    }
    if (wantsThinking) {
        generationConfig.thinkingConfig = { includeThoughts: true };
    }

    const res = await fetch(`${CLOUDCODE_BASE}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': agyUserAgent(),
        },
        body: JSON.stringify({
            project,
            model: targetModel,
            request: {
                systemInstruction: { parts: [{ text: sysText }] },
                contents,
                generationConfig,
            },
        }),
        signal,
    });

    if (res.status === 401 && !retriedAuth && auth.source === 'file') {
        const ok = await refreshAgyOAuthToken();
        if (ok) {
            yield* streamAgyDirect(profile, req, signal, LlmError, true);
            return;
        }
    }

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        if (res.status === 401 || res.status === 403) {
            throw new LlmError('auth', `Antigravity auth error (${res.status}): ${errText.slice(0, 400)}`, { status: res.status, retryable: false });
        }
        if (res.status === 429) {
            throw new LlmError('quota', `Antigravity quota / rate limit (${res.status}): ${errText.slice(0, 400)}`, { status: 429, retryable: false });
        }
        throw new LlmError('upstream', `Antigravity CloudCode HTTP ${res.status}: ${errText.slice(0, 500)}`, { status: res.status, retryable: false });
    }

    const rl = createInterface({ input: Readable.fromWeb(res.body) });
    let finishReason = 'stop';
    let usage = null;

    for await (const line of rl) {
        if (signal?.aborted) return;
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let parsed;
        try {
            parsed = JSON.parse(payload);
        } catch {
            continue;
        }
        const resp = parsed.response || parsed;
        const cand = resp.candidates?.[0];
        const parts = cand?.content?.parts;
        if (Array.isArray(parts)) {
            for (const p of parts) {
                if (p.thought && typeof p.text === 'string' && p.text) {
                    yield { reasoning: p.text };
                } else if (!p.thought && !p.thoughtSignature && typeof p.text === 'string' && p.text) {
                    yield { text: p.text };
                }
            }
        }
        if (cand?.finishReason === 'MAX_TOKENS') finishReason = 'length';
        if (resp.usageMetadata) {
            const inTok = resp.usageMetadata.promptTokenCount ?? 0;
            const outTok = (resp.usageMetadata.candidatesTokenCount ?? 0) + (resp.usageMetadata.thoughtsTokenCount ?? 0);
            usage = {
                prompt_tokens: inTok,
                completion_tokens: outTok,
                total_tokens: resp.usageMetadata.totalTokenCount ?? (inTok + outTok),
            };
        }
    }

    yield { done: { finishReason, ...(usage ? { usage } : {}) } };
}

async function* streamAgySubprocess(profile, req, signal, LlmError) {
    const bin = resolveAgyBinary();
    if (!bin) {
        throw new LlmError('auth', 'Antigravity CLI (`agy`) binary not found on this device.', { status: 400, retryable: false });
    }

    const requestedModel = req.model || profile.model || 'claude-sonnet-5-5-medium';
    const effort = req.params?.reasoning?.effort;
    const prompt = foldConversation(req.messages || [], { includeSystem: true });

    const workDir = join(tmpdir(), `sigma-agy-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true, mode: 0o700 });

    const args = [
        '--output-format', 'stream-json',
        '--disable-slash-commands',
        '--model', requestedModel,
    ];
    if (effort && ['low', 'medium', 'high', 'max'].includes(effort)) {
        args.push('--effort', effort);
    }
    args.push(`-p=${prompt}`);

    const proc = spawn(bin.command, args, {
        cwd: workDir,
        env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    let stderrText = '';
    proc.stderr.on('data', d => {
        stderrText = (stderrText + String(d)).slice(-3000);
    });

    const onAbort = () => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const rl = createInterface({ input: proc.stdout });
    let conversationId = null;
    let yieldedText = false;
    let usage = null;
    let errorText = null;

    try {
        for await (const line of rl) {
            if (signal?.aborted) break;
            if (!line.trim()) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }

            if (msg.conversation_id && !conversationId) {
                conversationId = msg.conversation_id;
            }
            if (msg.event === 'step_update' && msg.step_update) {
                const su = msg.step_update;
                if (!conversationId && su.conversation_id) conversationId = su.conversation_id;
                if (typeof su.thinking_delta === 'string' && su.thinking_delta) {
                    yield { reasoning: su.thinking_delta };
                } else if (typeof su.thinking === 'string' && su.thinking && su.state === 'DONE') {
                    yield { reasoning: su.thinking };
                }
                if (typeof su.text_delta === 'string' && su.text_delta) {
                    yieldedText = true;
                    yield { text: su.text_delta };
                }
                if (su.error_message) errorText = su.error_message;
                if (su.usage) {
                    usage = {
                        prompt_tokens: su.usage.input_tokens ?? 0,
                        completion_tokens: (su.usage.output_tokens ?? 0) + (su.usage.thinking_tokens ?? 0),
                        total_tokens: su.usage.total_tokens ?? 0,
                    };
                }
            } else if (msg.event === 'result' && msg.result) {
                const r = msg.result;
                if (!conversationId && r.conversation_id) conversationId = r.conversation_id;
                if (r.status && r.status !== 'SUCCESS') {
                    errorText = errorText || r.response || `Antigravity CLI exited with status ${r.status}`;
                } else if (!yieldedText && typeof r.response === 'string' && r.response) {
                    yieldedText = true;
                    yield { text: r.response };
                }
                if (r.usage) {
                    usage = {
                        prompt_tokens: r.usage.input_tokens ?? 0,
                        completion_tokens: (r.usage.output_tokens ?? 0) + (r.usage.thinking_tokens ?? 0),
                        total_tokens: r.usage.total_tokens ?? 0,
                    };
                }
            }
        }
    } finally {
        signal?.removeEventListener('abort', onAbort);
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
        if (conversationId) {
            try { unlinkSync(join(agyDataDir(), 'conversations', `${conversationId}.pb`)); } catch { /* ignore */ }
            try { rmSync(join(agyDataDir(), 'brain', conversationId), { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }

    if (signal?.aborted) return;
    if (errorText) {
        throw new LlmError('upstream', errorText.slice(0, 500), { status: 502, retryable: false });
    }
    if (!yieldedText && stderrText.trim()) {
        throw new LlmError('upstream', stderrText.trim().slice(0, 500), { status: 502, retryable: false });
    }

    yield { done: { finishReason: 'stop', ...(usage ? { usage } : {}) } };
}

export async function* streamAgyCli(profile, req, settings, signal, LlmError) {
    if (settings?.antigravityMode === 'cli') {
        yield* streamAgySubprocess(profile, req, signal, LlmError);
    } else {
        yield* streamAgyDirect(profile, req, signal, LlmError);
    }
}

export async function chatAgyCli(profile, req, settings, signal, LlmError) {
    let content = '';
    let reasoning = '';
    let finishReason = 'stop';
    let usage;
    for await (const part of streamAgyCli(profile, req, settings, signal, LlmError)) {
        if (part.text) content += part.text;
        if (part.reasoning) reasoning += part.reasoning;
        if (part.done) {
            finishReason = part.done.finishReason ?? finishReason;
            usage = part.done.usage ?? usage;
        }
    }
    return {
        content,
        ...(reasoning ? { reasoning } : {}),
        finishReason,
        ...(usage ? { usage } : {}),
    };
}

export async function agyStatus() {
    const bin = resolveAgyBinary();
    const version = detectAgyVersion();
    const auth = await getAgyAuthToken();
    const loggedIn = Boolean(auth?.accessToken);

    let tierName = null;
    const pools = [];

    if (auth?.accessToken) {
        try {
            const info = await resolveProjectAndTier(auth.accessToken);
            tierName = info.tierName;
            const cache = await discoverAgyModels({ force: true });
            const geminiSample = Object.entries(cache.rawMap || {}).find(([k, v]) => k.startsWith('gemini-') && v.quotaInfo)?.[1]?.quotaInfo;
            const claudeSample = Object.entries(cache.rawMap || {}).find(([k, v]) => k.startsWith('claude-') && v.quotaInfo)?.[1]?.quotaInfo;
            if (geminiSample && typeof geminiSample.remainingFraction === 'number') {
                pools.push({
                    name: 'Gemini Pool',
                    usedPct: Math.max(0, Math.round((1 - geminiSample.remainingFraction) * 1000) / 10),
                    remainingPct: Math.round(geminiSample.remainingFraction * 1000) / 10,
                    resetTime: geminiSample.resetTime || null,
                });
            }
            if (claudeSample && typeof claudeSample.remainingFraction === 'number') {
                pools.push({
                    name: 'Claude 5.5 / GPT-OSS Pool',
                    usedPct: Math.max(0, Math.round((1 - claudeSample.remainingFraction) * 1000) / 10),
                    remainingPct: Math.round(claudeSample.remainingFraction * 1000) / 10,
                    resetTime: claudeSample.resetTime || null,
                });
            }
        } catch { /* ignore */ }
    }

    return {
        installed: Boolean(bin),
        binaryPath: bin?.path ?? null,
        tokenPath: tokenFilePath(),
        version,
        loggedIn,
        email: auth?.email ?? null,
        tierName,
        pools,
    };
}
