// Direct Claude Code CLI runner for Project Sigma (zero npm dependencies).
// Spawns the local `claude` binary in stream-json mode with full roleplay isolation,
// OAuth token auto-refresh, and synthetic JSONL session replay for multi-turn chats.

import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
    existsSync,
    readFileSync,
    writeFileSync,
    renameSync,
    mkdirSync,
    rmdirSync,
    rmSync,
    statSync,
    chmodSync,
    unlinkSync,
} from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TEXT_ONLY_PREAMBLE, splitForResume, foldConversation } from './messages.js';

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_BETA_HEADER = 'oauth-2025-04-20';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 15000;

const TIER_ENV = {
    fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
    opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

const CANONICAL_TIER_MODELS = {
    fable: 'claude-fable-5-1',
    opus: 'claude-opus-5-5',
    sonnet: 'claude-sonnet-5-5',
    haiku: 'claude-haiku-4-5',
};

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const NO_XHIGH = ['low', 'medium', 'high', 'max'];
const M = 1_000_000;
const K200 = 200_000;

export const CLAUDE_MODELS = [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', tier: 'opus', context: M, thinking: 'always', efforts: EFFORT_LEVELS, defaultEffort: 'medium' },
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', tier: 'fable', context: M, thinking: 'always', efforts: EFFORT_LEVELS, defaultEffort: 'high' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', tier: 'sonnet', context: M, thinking: 'always', efforts: EFFORT_LEVELS, defaultEffort: 'medium' },
    { id: 'claude-opus-5', name: 'Claude Opus 5', tier: 'opus', context: M, thinking: 'adaptive', efforts: EFFORT_LEVELS, defaultEffort: 'high' },
    { id: 'claude-fable-5', name: 'Claude Fable 5', tier: 'fable', context: M, thinking: 'always', efforts: EFFORT_LEVELS, defaultEffort: 'high' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', tier: 'sonnet', context: M, thinking: 'adaptive', efforts: EFFORT_LEVELS, defaultEffort: 'high' },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', tier: 'opus', context: M, thinking: 'adaptive', efforts: EFFORT_LEVELS, defaultEffort: 'high' },
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', tier: 'opus', context: M, thinking: 'adaptive', efforts: EFFORT_LEVELS, defaultEffort: 'xhigh' },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'opus', context: K200, oneMVariant: true, thinking: 'hybrid', efforts: NO_XHIGH, defaultEffort: 'high' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'sonnet', context: K200, oneMVariant: true, thinking: 'hybrid', efforts: NO_XHIGH, defaultEffort: 'high' },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', tier: 'opus', context: K200, thinking: 'budget', efforts: [], defaultEffort: null },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', tier: 'sonnet', context: K200, thinking: 'budget', efforts: [], defaultEffort: null },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'haiku', context: K200, thinking: 'budget', efforts: [], defaultEffort: null },
];

const SCRUB_EXACT = new Set([
    'CLAUDECODE',
    'CLAUDE_CONFIG_DIR_OVERRIDE',
    'MAX_THINKING_TOKENS',
    'DISABLE_INTERLEAVED_THINKING',
    'FALLBACK_FOR_ALL_PRIMARY_MODELS',
    'DISABLE_AUTO_COMPACT',
    'DISABLE_COMPACT',
]);
const SCRUB_PREFIX = ['ANTHROPIC_', 'CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_', 'OTEL_', 'DISABLE_PROMPT_CACHING'];
const KEEP_ENV = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_GIT_BASH_PATH']);

const FIXED_ENV = Object.freeze({
    CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_REFUSAL_RETRY: '1',
    CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP: '1',
    CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    CLAUDE_CODE_THINKING_DISPLAY_UPDATES: '0',
    DISABLE_AUTO_COMPACT: '1',
    DISABLE_AUTOUPDATER: '1',
});

let cachedVersion = null;
let lastRateLimit = null;

function isNodeScript(filePath) {
    if (/\.(?:c|m)?js$/i.test(filePath)) return true;
    try {
        const fd = readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).slice(0, 128);
        return /^#!.*\bnode\b/i.test(fd);
    } catch {
        return false;
    }
}

export function resolveClaudeBinary() {
    const h = homedir();
    const candidates = [
        process.env.CLAUDE_PATH,
        '/data/data/com.termux/files/usr/bin/claude',
        join(h, '.local', 'bin', 'claude'),
        join(h, '.claude', 'local', 'claude'),
        ...String(process.env.PATH || '')
            .split(delimiter)
            .filter(Boolean)
            .map(dir => join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude')),
    ].filter(Boolean);

    for (const c of candidates) {
        if (existsSync(c)) {
            if (isNodeScript(c)) {
                return { command: process.execPath, args: [c], path: c };
            }
            return { command: c, args: [], path: c };
        }
    }
    return null;
}

export function detectClaudeVersion() {
    if (cachedVersion) return cachedVersion;
    const bin = resolveClaudeBinary();
    if (!bin) return null;
    try {
        const out = execFileSync(bin.command, [...bin.args, '--version'], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const m = out.match(/(\d+\.\d+\.\d+)/);
        cachedVersion = m ? m[1] : out;
        return cachedVersion;
    } catch {
        return null;
    }
}

function realClaudeConfigDir() {
    const ss = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    if (ss !== undefined && ss.trim()) return ss.trim();
    return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

function credentialsPath() {
    return join(realClaudeConfigDir(), '.credentials.json');
}

export function readClaudeCredentials() {
    try {
        return JSON.parse(readFileSync(credentialsPath(), 'utf8'));
    } catch {
        return null;
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withStorageLock(dir, fn) {
    const lockDir = join(dir, '.storage-write.lock');
    let locked = false;
    for (let attempt = 0; attempt < 25 && !locked; attempt++) {
        try {
            mkdirSync(lockDir);
            locked = true;
        } catch (err) {
            if (err?.code !== 'EEXIST') break;
            try {
                if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
                    rmdirSync(lockDir);
                    continue;
                }
            } catch {
                continue;
            }
            await sleep(80 + attempt * 40);
        }
    }
    try {
        return await fn();
    } finally {
        if (locked) {
            try { rmdirSync(lockDir); } catch { /* ignore */ }
        }
    }
}

async function writeCredentialsAtomic(path, data) {
    const json = JSON.stringify(data, null, 2);
    const tmpPath = `${path}.${process.pid}.tmp`;
    try {
        writeFileSync(tmpPath, json, { mode: 0o600 });
        renameSync(tmpPath, path);
        try { chmodSync(path, 0o600); } catch { /* ignore */ }
    } finally {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
}

let inflightRefresh = null;

export function refreshClaudeOAuthToken() {
    if (inflightRefresh) return inflightRefresh;
    inflightRefresh = (async () => {
        const path = credentialsPath();
        const creds = readClaudeCredentials();
        const refreshToken = creds?.claudeAiOauth?.refreshToken;
        if (!refreshToken) return false;
        try {
            const res = await fetch(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    grant_type: 'refresh_token',
                    client_id: OAUTH_CLIENT_ID,
                    refresh_token: refreshToken,
                }),
                signal: AbortSignal.timeout(15000),
            });
            if (!res.ok) {
                const latest = readClaudeCredentials();
                return Boolean(latest?.claudeAiOauth?.refreshToken && latest.claudeAiOauth.refreshToken !== refreshToken);
            }
            const data = await res.json();
            return await withStorageLock(dirname(path), async () => {
                const latest = readClaudeCredentials() ?? creds;
                const onDisk = latest?.claudeAiOauth?.refreshToken;
                if (onDisk && onDisk !== refreshToken) return true;
                const now = Date.now();
                latest.claudeAiOauth = {
                    ...latest.claudeAiOauth,
                    accessToken: data.access_token ?? latest.claudeAiOauth?.accessToken,
                    refreshToken: data.refresh_token ?? refreshToken,
                    expiresAt: data.expires_in ? now + data.expires_in * 1000 : now + 8 * 3600 * 1000,
                    ...(typeof data.scope === 'string' ? { scopes: data.scope.split(/\s+/).filter(Boolean) } : {}),
                };
                await writeCredentialsAtomic(path, latest);
                return true;
            });
        } catch {
            return false;
        }
    })().finally(() => {
        inflightRefresh = null;
    });
    return inflightRefresh;
}

export async function getClaudeAuthToken(profile) {
    const profileKey = String(profile?.api_key ?? '').trim();
    if (profileKey && !/^(none|null|undefined|placeholder|sk-no-key-needed)$/i.test(profileKey)) {
        return { source: 'profile', accessToken: profileKey };
    }
    const envToken = String(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim();
    if (envToken) {
        return { source: 'env', accessToken: envToken };
    }
    let oauth = readClaudeCredentials()?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    const expiresAt = Number(oauth.expiresAt) || 0;
    if ((!expiresAt || expiresAt - Date.now() < REFRESH_MARGIN_MS) && oauth.refreshToken) {
        await refreshClaudeOAuthToken();
        oauth = readClaudeCredentials()?.claudeAiOauth ?? oauth;
    }
    return {
        source: 'file',
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: Number(oauth.expiresAt) || 0,
        subscriptionType: oauth.subscriptionType ?? 'max',
        rateLimitTier: oauth.rateLimitTier ?? null,
    };
}

export function parseClaudeModel(requested) {
    const raw = String(requested || 'claude-sonnet-4-6').trim();
    const lower = raw.toLowerCase();
    const wants1m = lower.endsWith('[1m]');
    let rawBase = wants1m ? raw.slice(0, -4) : raw;
    if (/^(opus|sonnet|haiku|fable)$/i.test(rawBase)) {
        rawBase = CANONICAL_TIER_MODELS[rawBase.toLowerCase()];
    }
    const normalized = rawBase.toLowerCase().replace(/\./g, '-');
    const entry = CLAUDE_MODELS.find(m => m.id === rawBase.toLowerCase() || m.id === normalized) || null;
    const baseId = entry ? entry.id : (/^claude-/i.test(rawBase) ? normalized : rawBase);
    const tier = entry
        ? entry.tier
        : (baseId.includes('fable') ? 'fable' : baseId.includes('opus') ? 'opus' : baseId.includes('haiku') ? 'haiku' : 'sonnet');
    const envPins = {};
    for (const [t, envVar] of Object.entries(TIER_ENV)) envPins[envVar] = CANONICAL_TIER_MODELS[t];
    envPins[TIER_ENV[tier]] = baseId;

    const oneM = wants1m && (entry ? !!entry.oneMVariant : true);
    const sdkModel = oneM ? `${tier}[1m]` : baseId;
    const contextLength = entry ? (oneM ? M : entry.context) : (oneM ? M : K200);
    return {
        baseId,
        sdkModel,
        envPins,
        contextLength,
        efforts: entry ? entry.efforts : EFFORT_LEVELS,
        defaultEffort: entry ? entry.defaultEffort : 'high',
        thinking: entry ? entry.thinking : 'adaptive',
    };
}

function clampEffort(modelInfo, effort) {
    if (!effort) return undefined;
    const allowed = modelInfo.efforts || EFFORT_LEVELS;
    if (!allowed.length) return undefined;
    if (allowed.includes(effort)) return effort;
    const idx = EFFORT_LEVELS.indexOf(effort);
    for (let i = idx; i >= 0; i--) {
        if (allowed.includes(EFFORT_LEVELS[i])) return EFFORT_LEVELS[i];
    }
    return allowed[0];
}

export function listClaudeCliModels() {
    const out = [];
    for (const m of CLAUDE_MODELS) {
        out.push({ id: m.id, contextLength: m.context, vision: true });
        if (m.oneMVariant) {
            out.push({ id: `${m.id}[1m]`, contextLength: M, vision: true });
        }
    }
    return out;
}

function setEnv(env, name, value) {
    const upper = name.toUpperCase();
    for (const k of Object.keys(env)) {
        if (k.toUpperCase() === upper) delete env[k];
    }
    if (value !== undefined) env[name] = value;
}

function buildClaudeEnv({ envPins, maxTokens, oauthToken, configDir, identityMode, fastMode }) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        const upper = k.toUpperCase();
        if (!KEEP_ENV.has(upper) && (SCRUB_EXACT.has(upper) || SCRUB_PREFIX.some(p => upper.startsWith(p)))) continue;
        env[k] = v;
    }
    for (const [k, v] of Object.entries({ ...envPins, ...FIXED_ENV })) {
        setEnv(env, k, v);
    }
    if (fastMode) setEnv(env, 'CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK', '1');
    if (maxTokens && Number.isFinite(maxTokens) && maxTokens > 0) {
        setEnv(env, 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', String(Math.max(4096, Math.round(maxTokens))));
    }
    if (!identityMode && oauthToken && configDir) {
        setEnv(env, 'CLAUDE_CODE_OAUTH_TOKEN', oauthToken);
        setEnv(env, 'CLAUDE_CONFIG_DIR', configDir);
        setEnv(env, 'CLAUDE_SECURESTORAGE_CONFIG_DIR', configDir);
    }
    return env;
}

function turnToAnthropicContent(turn) {
    const images = Array.isArray(turn.images) ? turn.images : [];
    if (images.length > 0) {
        const blocks = images.map(img => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.data },
        }));
        if (turn.text) blocks.push({ type: 'text', text: turn.text });
        return blocks;
    }
    return turn.text || '[Start]';
}

function writeSyntheticSessionJsonl({ configDir, cwd, sessionId, history, model, version }) {
    const cwdKey = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const projDir = join(configDir, 'projects', cwdKey);
    mkdirSync(projDir, { recursive: true });
    let parentUuid = null;
    const lines = [];
    for (const turn of history) {
        const uuid = randomUUID();
        const ts = new Date().toISOString();
        if (turn.role === 'assistant') {
            lines.push(JSON.stringify({
                parentUuid,
                isSidechain: false,
                message: {
                    model,
                    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'text', text: turn.text || '[...]' }],
                    stop_reason: 'end_turn',
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                },
                requestId: `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
                type: 'assistant',
                uuid,
                timestamp: ts,
                userType: 'external',
                entrypoint: 'cli',
                cwd,
                sessionId,
                version,
            }));
        } else {
            lines.push(JSON.stringify({
                parentUuid,
                isSidechain: false,
                promptId: randomUUID(),
                type: 'user',
                message: { role: 'user', content: turnToAnthropicContent(turn) },
                uuid,
                timestamp: ts,
                permissionMode: 'dontAsk',
                userType: 'external',
                entrypoint: 'cli',
                cwd,
                sessionId,
                version,
            }));
        }
        parentUuid = uuid;
    }
    writeFileSync(join(projDir, `${sessionId}.jsonl`), lines.join('\n') + '\n', { mode: 0o600 });
}

function recordRateLimit(info) {
    if (!info || typeof info !== 'object') return;
    const windows = [];
    for (const [key, w] of Object.entries(info.unifiedWindows ?? {})) {
        if (!w) continue;
        const utilization = typeof w.utilization === 'number' ? Math.max(0, w.utilization) : null;
        const resetsAt = typeof w.resetsAt === 'number' ? (w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt) : null;
        if (utilization !== null || resetsAt !== null) windows.push({ type: key, utilization, resetsAt });
    }
    if (!windows.length && info.rateLimitType) {
        const utilization = typeof info.utilization === 'number' ? Math.max(0, info.utilization) : null;
        const resetsAt = typeof info.resetsAt === 'number' ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : null;
        if (utilization !== null || resetsAt !== null) windows.push({ type: info.rateLimitType, utilization, resetsAt });
    }
    lastRateLimit = {
        status: info.status ?? null,
        rateLimitType: info.rateLimitType ?? null,
        windows,
        observedAt: Date.now(),
    };
}

function classifyClaudeError(text, LlmError) {
    const s = String(text || 'Claude Code CLI error').trim();
    const lower = s.toLowerCase();
    if (
        lower.includes('oauth token has expired') ||
        lower.includes('token_expired') ||
        lower.includes('invalid_token') ||
        lower.includes('not logged in') ||
        lower.includes('please run /login') ||
        lower.includes('authentication_failed') ||
        lower.includes('invalid api key')
    ) {
        return new LlmError('auth', `${s} — Run \`claude auth login\` in Termux.`, { status: 401, retryable: false });
    }
    if (
        lower.includes('hit your limit') ||
        lower.includes('usage limit') ||
        lower.includes('out of extra usage') ||
        lower.includes('rate_limit') ||
        lower.includes('too many requests')
    ) {
        return new LlmError('quota', s, { status: 429, retryable: false });
    }
    if (lower.includes('prompt is too long') || lower.includes('context_length')) {
        return new LlmError('context', s, { status: 400, retryable: false });
    }
    return new LlmError('upstream', s.slice(0, 600), { status: 502, retryable: false });
}

export async function* streamClaudeCli(profile, req, settings, signal, LlmError, retriedAuth = false) {
    const bin = resolveClaudeBinary();
    if (!bin) {
        throw new LlmError('auth', 'Claude Code CLI (`claude`) was not found on this device. Install `@anthropic-ai/claude-code` and run `claude auth login`.', {
            status: 400,
            retryable: false,
        });
    }

    const auth = await getClaudeAuthToken(profile);
    if (!auth?.accessToken) {
        throw new LlmError('auth', 'No Claude Code OAuth login found in `~/.claude/.credentials.json`. Run `claude auth login` in Termux.', {
            status: 401,
            retryable: false,
        });
    }

    const modelInfo = parseClaudeModel(req.model || profile.model || 'claude-sonnet-4-6');
    const rawEffort = req.params?.reasoning?.effort;
    const effort = clampEffort(modelInfo, rawEffort);
    const maxTokens = req.params?.maxTokens;
    const stops = Array.isArray(req.params?.stop) ? req.params.stop.filter(s => typeof s === 'string' && s.length > 0) : [];

    const useResume = settings?.claudeUseResume !== false;
    const identityMode = settings?.claudeIdentityMode === true;
    const fastMode = settings?.claudeFastMode === true;

    const { system, history, current } = splitForResume(req.messages || []);
    const systemPrompt = system ? `${system}\n\n${TEXT_ONLY_PREAMBLE}` : TEXT_ONLY_PREAMBLE;

    const workDir = join(tmpdir(), `sigma-claude-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true, mode: 0o700 });

    const sessionId = randomUUID();
    const canResume = useResume && history.length > 0 && !identityMode;
    const version = detectClaudeVersion() || '2.1.314';

    if (canResume) {
        writeSyntheticSessionJsonl({
            configDir: workDir,
            cwd: workDir,
            sessionId,
            history,
            model: modelInfo.baseId,
            version,
        });
    }

    const userTurn = canResume
        ? current
        : {
            role: 'user',
            text: foldConversation(req.messages || [], { includeSystem: false }),
            images: current.images || [],
        };

    const cliArgs = [
        ...bin.args,
        '-p',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--system-prompt', systemPrompt,
        '--system-prompt-snapshot', 'off',
        '--tools', '',
        '--disable-slash-commands',
        '--setting-sources', '',
        '--strict-mcp-config',
        '--permission-mode', 'dontAsk',
        '--model', modelInfo.sdkModel,
    ];
    if (effort) cliArgs.push('--effort', effort);
    if (canResume) {
        cliArgs.push('--resume', sessionId);
    } else {
        cliArgs.push('--no-session-persistence');
    }

    const env = buildClaudeEnv({
        envPins: modelInfo.envPins,
        maxTokens,
        oauthToken: auth.accessToken,
        configDir: workDir,
        identityMode,
        fastMode,
    });

    const proc = spawn(bin.command, cliArgs, {
        cwd: workDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });

    let stderrText = '';
    proc.stderr.on('data', chunk => {
        stderrText = (stderrText + String(chunk)).slice(-4000);
    });
    proc.stdin.on('error', () => { /* ignore EPIPE */ });

    const onAbort = () => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const stdinPayload = {
        type: 'user',
        message: {
            role: 'user',
            content: turnToAnthropicContent(userTurn),
        },
        parent_tool_use_id: null,
    };
    proc.stdin.write(JSON.stringify(stdinPayload) + '\n');
    proc.stdin.end();

    const rl = createInterface({ input: proc.stdout });
    let yieldedText = false;
    let yieldedReasoning = false;
    let finishReason = 'stop';
    let usage = null;
    let resultError = null;
    let fullText = '';
    let hitStop = false;

    try {
        for await (const line of rl) {
            if (signal?.aborted) break;
            if (!line.trim()) continue;
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }

            if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
                recordRateLimit(msg.rate_limit_info);
                continue;
            }

            if (msg.type === 'stream_event' && msg.event) {
                const ev = msg.event;
                if (ev.type === 'content_block_delta' && ev.delta) {
                    if (ev.delta.type === 'thinking_delta' && typeof ev.delta.thinking === 'string' && ev.delta.thinking) {
                        yieldedReasoning = true;
                        yield { reasoning: ev.delta.thinking };
                    } else if (ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string' && ev.delta.text) {
                        let chunk = ev.delta.text;
                        if (stops.length > 0) {
                            const combined = fullText + chunk;
                            let earliestIdx = -1;
                            for (const stopSeq of stops) {
                                const idx = combined.indexOf(stopSeq);
                                if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
                                    earliestIdx = idx;
                                }
                            }
                            if (earliestIdx !== -1) {
                                const allowed = combined.slice(fullText.length, earliestIdx);
                                if (allowed) {
                                    yieldedText = true;
                                    yield { text: allowed };
                                }
                                hitStop = true;
                                finishReason = 'stop';
                                try { proc.kill('SIGTERM'); } catch { /* ignore */ }
                                break;
                            }
                        }
                        fullText += chunk;
                        yieldedText = true;
                        yield { text: chunk };
                    }
                } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
                    finishReason = ev.delta.stop_reason === 'max_tokens' ? 'length' : 'stop';
                }
                continue;
            }

            if (msg.type === 'assistant' && msg.message?.content && !yieldedText) {
                for (const block of msg.message.content) {
                    if (block.type === 'thinking' && block.thinking && !yieldedReasoning) {
                        yieldedReasoning = true;
                        yield { reasoning: block.thinking };
                    } else if (block.type === 'text' && block.text && !yieldedText) {
                        yieldedText = true;
                        fullText += block.text;
                        yield { text: block.text };
                    }
                }
                if (msg.error) {
                    resultError = typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error);
                }
                continue;
            }

            if (msg.type === 'result') {
                if (msg.is_error) {
                    const errs = Array.isArray(msg.errors) && msg.errors.length ? msg.errors.join('; ') : null;
                    resultError = msg.result || errs || stderrText || 'Claude Code CLI returned an error result';
                } else {
                    if (!yieldedText && typeof msg.result === 'string' && msg.result) {
                        yieldedText = true;
                        yield { text: msg.result };
                    }
                    if (msg.stop_reason === 'max_tokens') finishReason = 'length';
                    else if (msg.stop_reason === 'refusal') {
                        resultError = 'Claude refused this request (stop_reason: refusal).';
                    }
                    if (msg.usage) {
                        const inTok = (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0);
                        const outTok = msg.usage.output_tokens ?? 0;
                        usage = {
                            prompt_tokens: inTok,
                            completion_tokens: outTok,
                            total_tokens: inTok + outTok,
                        };
                    }
                }
            }
        }
    } finally {
        signal?.removeEventListener('abort', onAbort);
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    if (signal?.aborted) return;

    if (resultError && !hitStop) {
        const lower = String(resultError).toLowerCase();
        const isAuth =
            lower.includes('oauth token has expired') ||
            lower.includes('token_expired') ||
            lower.includes('invalid_token') ||
            lower.includes('authentication_failed');
        if (isAuth && !retriedAuth && auth.source === 'file' && auth.refreshToken && !yieldedText) {
            const refreshed = await refreshClaudeOAuthToken();
            if (refreshed) {
                yield* streamClaudeCli(profile, req, settings, signal, LlmError, true);
                return;
            }
        }
        throw classifyClaudeError(resultError, LlmError);
    }

    if (!yieldedText && !yieldedReasoning && stderrText.trim()) {
        throw classifyClaudeError(stderrText.trim(), LlmError);
    }

    yield { done: { finishReason, ...(usage ? { usage } : {}) } };
}

export async function chatClaudeCli(profile, req, settings, signal, LlmError) {
    let content = '';
    let reasoning = '';
    let finishReason = 'stop';
    let usage;
    for await (const part of streamClaudeCli(profile, req, settings, signal, LlmError)) {
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

export async function claudeStatus() {
    const bin = resolveClaudeBinary();
    const version = detectClaudeVersion();
    const creds = readClaudeCredentials()?.claudeAiOauth;
    const hasEnvToken = Boolean(String(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim());
    const loggedIn = Boolean(hasEnvToken || creds?.accessToken);

    let quota = null;
    if (creds?.accessToken) {
        try {
            const res = await fetch(USAGE_URL, {
                headers: {
                    Authorization: `Bearer ${creds.accessToken}`,
                    'anthropic-beta': USAGE_BETA_HEADER,
                    Accept: 'application/json',
                },
                signal: AbortSignal.timeout(6000),
            });
            if (res.ok) {
                const raw = await res.json();
                const windows = [];
                for (const key of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
                    const w = raw?.[key];
                    if (w && typeof w.utilization === 'number') {
                        windows.push({
                            type: key,
                            utilization: Math.max(0, w.utilization / 100),
                            resetsAt: w.resets_at ? Date.parse(w.resets_at) || null : null,
                        });
                    }
                }
                quota = { source: 'oauth-usage', windows };
            }
        } catch {
            // Fall back to lastRateLimit below
        }
    }
    if (!quota && lastRateLimit) {
        quota = { source: 'rate-limit-event', windows: lastRateLimit.windows };
    }

    return {
        installed: Boolean(bin),
        binaryPath: bin?.path ?? null,
        version,
        loggedIn,
        subscriptionType: creds?.subscriptionType ?? (hasEnvToken ? 'token' : null),
        rateLimitTier: creds?.rateLimitTier ?? null,
        expiresAt: creds?.expiresAt ?? null,
        quota,
    };
}
