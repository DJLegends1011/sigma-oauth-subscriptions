// Direct Codex CLI (`codex app-server --stdio`) runner for Project Sigma.
// Uses JSON-RPC 2.0 over stdio with ephemeral tool-less roleplay threads, streaming
// token deltas, reasoning summaries, vision data URLs, and live model discovery.

import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { windowsBinCandidates } from './win-bin.js';
import { homedir, tmpdir } from 'node:os';
import { TEXT_ONLY_PREAMBLE, splitForResume, foldConversation } from './messages.js';

const REQUEST_TIMEOUT_MS = 30000;
const INIT_TIMEOUT_MS = 60000;
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

const DISABLED_FEATURES = [
    'shell_tool', 'unified_exec', 'view_image', 'sleep_tool', 'multi_agent', 'apps', 'plugins', 'hooks',
    'goals', 'image_generation', 'browser_use', 'computer_use', 'skill_search', 'tool_suggest', 'memories',
];

const CONTEXT_OVERRIDES = [
    'include_environment_context=false',
    'include_permissions_instructions=false',
    'include_apps_instructions=false',
    'include_collaboration_mode_instructions=false',
    'skills.include_instructions=false',
    'skills.bundled.enabled=false',
];

const SAFE_MCP_NAME = /^[A-Za-z0-9_-]+$/;
const SAFE_PLUGIN_NAME = /^[A-Za-z0-9_@-]+$/;

const TOOL_ITEM_TYPES = new Set([
    'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch',
    'imageView', 'imageGeneration', 'collabAgentToolCall', 'subAgentActivity',
]);

export const STATIC_CODEX_MODELS = [
    { id: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'low', context: 272000 },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'low', context: 272000 },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', context: 272000 },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', context: 272000 },
    { id: 'gpt-5.5', name: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', context: 272000 },
    { id: 'gpt-5.4', name: 'GPT-5.4', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', context: 272000 },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', context: 272000 },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', context: 272000 },
    { id: 'gpt-5.2', name: 'GPT-5.2', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', context: 272000 },
];

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

let cachedVersion = null;
let modelCache = { at: 0, source: 'static', models: STATIC_CODEX_MODELS };

function isNodeScript(filePath) {
    try {
        const real = realpathSync(filePath);
        if (/\.(?:c|m)?js$/i.test(real)) return true;
        const head = readFileSync(real, { encoding: 'utf8', flag: 'r' }).slice(0, 128);
        return /^#!.*\bnode\b/i.test(head);
    } catch {
        return /\.(?:c|m)?js$/i.test(filePath);
    }
}

export function resolveCodexBinary() {
    const h = homedir();
    const candidates = [
        process.env.CODEX_PATH,
        '/data/data/com.termux/files/usr/bin/codex',
        '/data/data/com.termux/files/usr/lib/node_modules/@openai/codex/bin/codex.js',
        join(h, '.local', 'bin', 'codex'),
        join(h, '.codex', 'bin', 'codex'),
        ...(process.platform === 'win32'
            ? windowsBinCandidates('codex')
            : String(process.env.PATH || '')
                .split(delimiter)
                .filter(Boolean)
                .map(dir => join(dir, 'codex'))),
    ].filter(Boolean);

    for (const c of candidates) {
        if (existsSync(c)) {
            if (isNodeScript(c)) {
                let target = c;
                try { target = realpathSync(c); } catch { /* keep c */ }
                return { command: process.execPath, args: [target], path: c };
            }
            return { command: c, args: [], path: c };
        }
    }
    return null;
}

export function detectCodexVersion() {
    if (cachedVersion) return cachedVersion;
    const bin = resolveCodexBinary();
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

export function resolveCodexHome() {
    if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
    const h = homedir();
    const candidates = [join(h, '.codex'), join(h, '.codex-cli')];
    for (const c of candidates) {
        if (existsSync(join(c, 'auth.json')) || existsSync(join(c, 'config.toml'))) return c;
    }
    return join(h, '.codex');
}

export function readCodexAuthSummary(home = resolveCodexHome()) {
    const path = join(home, 'auth.json');
    if (!existsSync(path)) return { present: false, path };
    try {
        const a = JSON.parse(readFileSync(path, 'utf8'));
        const mode = a.auth_mode ?? (a.tokens ? 'chatgpt' : (a.OPENAI_API_KEY ? 'apikey' : 'unknown'));
        return {
            present: true,
            path,
            mode,
            lastRefresh: a.last_refresh ?? null,
            hasTokens: Boolean(a.tokens),
        };
    } catch {
        return { present: true, path, mode: 'unreadable' };
    }
}

function scanCodexConfigNames(home = resolveCodexHome()) {
    const path = join(home, 'config.toml');
    const mcpNames = new Set();
    const pluginNames = new Set();
    try {
        const text = readFileSync(path, 'utf8');
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const sec = line.match(/^\[+\s*mcp_servers\.([A-Za-z0-9_-]+)/);
            if (sec) mcpNames.add(sec[1]);
            const kv = line.match(/^mcp_servers\.([A-Za-z0-9_-]+)\s*=/);
            if (kv) mcpNames.add(kv[1]);
            const psec = line.match(/^\[+\s*plugins\.([A-Za-z0-9_@-]+)/);
            if (psec) pluginNames.add(psec[1]);
        }
    } catch {
        // Ignore missing config.toml
    }
    return { mcpNames: [...mcpNames], pluginNames: [...pluginNames] };
}

function buildIsolationOverrides(scan, { extraMcpNames = [], webSearchKey = true } = {}) {
    const args = ['-c', 'notify=[]', '-c', 'project_doc_max_bytes=0', '-c', 'thread_unload_delay_secs=1'];
    for (const f of DISABLED_FEATURES) args.push('-c', `features.${f}=false`);
    if (webSearchKey) args.push('-c', 'web_search="disabled"');
    for (const o of CONTEXT_OVERRIDES) args.push('-c', o);
    const mcp = [...new Set([...(scan?.mcpNames ?? []), ...extraMcpNames])];
    for (const n of mcp) {
        if (SAFE_MCP_NAME.test(n)) args.push('-c', `mcp_servers.${n}.enabled=false`);
    }
    for (const n of scan?.pluginNames ?? []) {
        if (SAFE_PLUGIN_NAME.test(n)) args.push('-c', `plugins.${n}.enabled=false`);
    }
    return args;
}

function enabledMcpServers(effective) {
    const servers = effective?.mcp_servers;
    if (!servers || typeof servers !== 'object') return [];
    return Object.entries(servers)
        .filter(([, v]) => v && typeof v === 'object' && v.enabled !== false)
        .map(([k]) => k);
}

function getSafeCwd() {
    const dir = join(tmpdir(), 'sigma-codex-cwd');
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
    return dir;
}

class CodexAppServer extends EventEmitter {
    #proc = null;
    #nextId = 1;
    #pending = new Map();
    #starting = null;
    #threadListeners = new Map();
    #stderrTail = '';
    #learnedMcp = new Set();
    info = null;
    codexHome = null;
    lastRateLimits = null;
    lastAccount = null;

    get alive() {
        return Boolean(this.#proc && this.#proc.exitCode === null && !this.#proc.killed);
    }

    get ready() {
        return this.alive && Boolean(this.info) && !this.#starting;
    }

    start() {
        if (this.#starting) return this.#starting;
        if (this.alive && this.info) return Promise.resolve(this);
        const configHome = this.codexHome ?? resolveCodexHome();
        this.#learnedMcp.clear();
        this.#starting = this.#doStart(configHome, 0).finally(() => {
            this.#starting = null;
        });
        return this.#starting;
    }

    #spawn(bin, args) {
        if (this.#proc) this.#failAll(new Error('Codex app-server restarted'));
        const proc = spawn(bin.command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, CODEX_CI: '1' },
            cwd: getSafeCwd(),
            windowsHide: true,
        });
        this.#proc = proc;
        this.info = null;
        this.#stderrTail = '';

        proc.stdin.on('error', () => { /* ignore EPIPE */ });
        proc.stdout.on('error', () => { /* ignore */ });
        proc.stderr.on('error', () => { /* ignore */ });
        proc.stderr.on('data', d => {
            const s = String(d).replace(/\x1b\[[0-9;]*m/g, '');
            this.#stderrTail = (this.#stderrTail + s).slice(-3000);
        });
        createInterface({ input: proc.stdout }).on('line', line => this.#onLine(line));
        proc.on('exit', code => {
            if (this.#proc !== proc) return;
            const err = new Error(`Codex app-server exited (code ${code})${this.#stderrTail ? ': ' + this.#stderrTail.trim().slice(-240) : ''}`);
            this.#failAll(err);
            this.#proc = null;
            this.info = null;
        });
        proc.on('error', err => {
            if (this.#proc !== proc) return;
            this.#failAll(err);
            this.#proc = null;
            this.info = null;
        });
    }

    async #doStart(configHome, attempt, { webSearchKey = true, useScan = true } = {}) {
        const bin = resolveCodexBinary();
        if (!bin) {
            throw new Error('Codex CLI (`codex`) not found. Install `@openai/codex` and run `codex login`.');
        }
        const scan = useScan ? scanCodexConfigNames(configHome) : { mcpNames: [], pluginNames: [] };
        const overrides = buildIsolationOverrides(scan, { extraMcpNames: [...this.#learnedMcp], webSearchKey });
        this.#spawn(bin, [...bin.args, 'app-server', '--stdio', ...overrides]);

        let init;
        try {
            init = await this.request('initialize', {
                clientInfo: { name: 'project-sigma-oauth-subscriptions', version: '1.0.0' },
            }, INIT_TIMEOUT_MS);
        } catch (err) {
            const text = err?.message ?? '';
            this.stop();
            if (webSearchKey && /web_search/i.test(text)) {
                return this.#doStart(configHome, attempt, { webSearchKey: false, useScan });
            }
            if (useScan && /mcp_servers/i.test(text)) {
                return this.#doStart(configHome, attempt, { webSearchKey, useScan: false });
            }
            throw err;
        }
        this.notify('initialized', {});
        this.info = init;
        this.codexHome = init?.codexHome ?? configHome;

        try {
            const effective = await this.request('config/read', { includeLayers: false, cwd: getSafeCwd() }, REQUEST_TIMEOUT_MS);
            const stillEnabled = enabledMcpServers(effective?.config);
            if (stillEnabled.length && attempt === 0) {
                for (const n of stillEnabled) {
                    if (SAFE_MCP_NAME.test(n)) this.#learnedMcp.add(n);
                }
                this.stop();
                return this.#doStart(this.codexHome, attempt + 1, { webSearchKey, useScan });
            }
        } catch {
            // Proceed if config/read is unsupported on an older build
        }
        return this;
    }

    #failAll(err) {
        for (const p of this.#pending.values()) p.reject(err);
        this.#pending.clear();
        for (const [threadId, fns] of this.#threadListeners) {
            for (const fn of fns) fn({ method: 'sigma/exit', params: { threadId, error: err } });
        }
        this.#threadListeners.clear();
    }

    #onLine(line) {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.id !== undefined && msg.method === undefined) {
            const p = this.#pending.get(msg.id);
            if (!p) return;
            this.#pending.delete(msg.id);
            if (msg.error) {
                const err = new Error(msg.error.message ?? 'Codex app-server error');
                err.code = msg.error.code;
                p.reject(err);
            } else {
                p.resolve(msg.result);
            }
            return;
        }
        if (msg.method && msg.id !== undefined) {
            this.#answerServerRequest(msg);
            return;
        }
        if (msg.method) {
            const params = msg.params ?? {};
            if (msg.method === 'account/rateLimits/updated' && params.rateLimits) {
                this.lastRateLimits = { ...params.rateLimits, observedAt: Date.now() };
            }
            const threadId = params.threadId ?? params.thread?.id;
            if (threadId && this.#threadListeners.has(threadId)) {
                for (const fn of this.#threadListeners.get(threadId)) fn(msg);
            }
        }
    }

    #answerServerRequest(msg) {
        let result;
        switch (msg.method) {
            case 'item/commandExecution/requestApproval':
            case 'item/fileChange/requestApproval':
                result = { decision: 'decline' };
                break;
            case 'execCommandApproval':
            case 'applyPatchApproval':
                result = { decision: 'abort' };
                break;
            case 'item/tool/requestUserInput':
                result = { answers: {} };
                break;
            case 'item/tool/call':
                result = { contentItems: [], success: false };
                break;
            case 'mcpServer/elicitation/request':
                result = { action: 'decline', content: null };
                break;
            default:
                this.#safeWrite({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unsupported in roleplay mode' } });
                return;
        }
        this.#safeWrite({ jsonrpc: '2.0', id: msg.id, result });
    }

    #safeWrite(obj) {
        try {
            if (this.alive) this.#proc.stdin.write(JSON.stringify(obj) + '\n');
        } catch { /* ignore */ }
    }

    request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`Codex app-server request ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            timer.unref?.();
            this.#pending.set(id, {
                resolve: v => { clearTimeout(timer); resolve(v); },
                reject: e => { clearTimeout(timer); reject(e); },
            });
            try {
                if (!this.alive) throw new Error('Codex app-server is not running');
                this.#proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? null }) + '\n');
            } catch (err) {
                clearTimeout(timer);
                this.#pending.delete(id);
                reject(err);
            }
        });
    }

    notify(method, params) {
        this.#safeWrite({ jsonrpc: '2.0', method, params: params ?? {} });
    }

    subscribeThread(threadId, fn) {
        if (!this.#threadListeners.has(threadId)) this.#threadListeners.set(threadId, new Set());
        this.#threadListeners.get(threadId).add(fn);
        return () => {
            const set = this.#threadListeners.get(threadId);
            if (!set) return;
            set.delete(fn);
            if (set.size === 0) this.#threadListeners.delete(threadId);
        };
    }

    stop() {
        const proc = this.#proc;
        this.#failAll(new Error('Codex app-server stopped'));
        this.#proc = null;
        this.info = null;
        if (proc && proc.exitCode === null) {
            try { proc.stdin.end(); } catch { /* ignore */ }
            const t = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 1000);
            t.unref?.();
        }
    }
}

let sharedServer = null;

async function getAppServer() {
    if (!sharedServer) sharedServer = new CodexAppServer();
    await sharedServer.start();
    return sharedServer;
}

function fromModelsCacheFile(home = resolveCodexHome()) {
    try {
        const raw = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8'));
        const out = [];
        for (const m of raw.models ?? []) {
            if (!m?.slug || m.visibility === 'hide') continue;
            out.push({
                id: m.slug,
                name: m.display_name || m.slug,
                efforts: (m.supported_reasoning_levels ?? []).map(l => l.effort).filter(Boolean),
                defaultEffort: m.default_reasoning_level || 'medium',
                context: m.context_window || 272000,
            });
        }
        return out.length ? out : null;
    } catch {
        return null;
    }
}

export async function discoverCodexModels({ live = true } = {}) {
    if (Date.now() - modelCache.at < MODEL_CACHE_TTL_MS && modelCache.source !== 'static') {
        return modelCache.models;
    }
    if (live && resolveCodexBinary()) {
        try {
            const server = await getAppServer();
            const res = await server.request('model/list', { includeHidden: false }, 15000);
            const list = (res?.data ?? res?.models ?? [])
                .filter(m => m && !m.hidden && (m.model || m.id))
                .map(m => ({
                    id: m.model || m.id,
                    name: m.displayName || m.model || m.id,
                    efforts: (m.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort).filter(Boolean),
                    defaultEffort: m.defaultReasoningEffort || 'medium',
                    context: 272000,
                }));
            if (list.length) {
                modelCache = { at: Date.now(), source: 'app-server', models: list };
                return list;
            }
        } catch {
            // Fall back to models_cache.json
        }
    }
    const cached = fromModelsCacheFile(sharedServer?.codexHome ?? resolveCodexHome());
    if (cached) {
        modelCache = { at: Date.now(), source: 'models_cache.json', models: cached };
        return cached;
    }
    return STATIC_CODEX_MODELS;
}

export async function listCodexCliModels() {
    const models = await discoverCodexModels({ live: true });
    return models.map(m => ({
        id: m.id,
        contextLength: m.context || 272000,
        vision: true,
    }));
}

function resolveCodexEffort(modelId, requestedEffort) {
    const info = modelCache.models.find(m => m.id.toLowerCase() === String(modelId).toLowerCase())
        ?? STATIC_CODEX_MODELS.find(m => m.id.toLowerCase() === String(modelId).toLowerCase());
    const raw = requestedEffort === 'ultra' ? 'max' : (requestedEffort || info?.defaultEffort || 'medium');
    const want = EFFORT_ORDER.indexOf(raw);
    if (want < 0) return info?.defaultEffort || 'medium';
    const supported = (info?.efforts ?? ['low', 'medium', 'high', 'xhigh']).filter(e => e !== 'ultra' && EFFORT_ORDER.includes(e));
    if (!supported.length || supported.includes(raw)) return raw;
    const ranked = [...supported].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
    const lower = ranked.filter(e => EFFORT_ORDER.indexOf(e) <= want);
    return lower.at(-1) ?? ranked[0];
}

function classifyCodexTurnError(error, LlmError) {
    const info = error?.codexErrorInfo;
    const code = typeof info === 'string' ? info : (info && typeof info === 'object' ? Object.keys(info)[0] ?? null : null);
    const base = String(error?.message ?? 'Codex CLI error');
    const details = typeof error?.additionalDetails === 'string' && error.additionalDetails.trim()
        ? ` (${error.additionalDetails.trim()})`
        : '';
    if (code === 'usageLimitExceeded' || code === 'rateLimitExceeded' || code === 'sessionBudgetExceeded') {
        return new LlmError('quota', `${base}${details}`, { status: 429, retryable: false });
    }
    if (code === 'unauthorized') {
        return new LlmError('auth', `${base}${details} — Run \`codex login\`.`, { status: 401, retryable: false });
    }
    if (code === 'contextWindowExceeded') {
        return new LlmError('context', `${base}${details}`, { status: 400, retryable: false });
    }
    return new LlmError('upstream', `${base}${details}`.slice(0, 600), { status: 502, retryable: false });
}

export async function* streamCodexCli(profile, req, settings, signal, LlmError) {
    if (!resolveCodexBinary()) {
        throw new LlmError('auth', 'Codex CLI (`codex`) was not found on this device. Install `@openai/codex` and run `codex login`.', {
            status: 400,
            retryable: false,
        });
    }

    await discoverCodexModels({ live: false });
    let server;
    try {
        server = await getAppServer();
    } catch (err) {
        throw new LlmError('upstream', err instanceof Error ? err.message : String(err), { status: 502, retryable: false });
    }

    const auth = readCodexAuthSummary(server.codexHome ?? resolveCodexHome());
    if (!auth.present) {
        throw new LlmError('auth', 'No Codex CLI login found in `~/.codex/auth.json`. Run `codex login`.', {
            status: 401,
            retryable: false,
        });
    }

    const model = req.model || profile.model || 'gpt-5.4';
    const { system, current } = splitForResume(req.messages || []);
    const baseInstructions = system
        ? `${system}\n\n${TEXT_ONLY_PREAMBLE}`
        : `You are a conversational partner in a chat application. Follow the conversation and reply in character. ${TEXT_ONLY_PREAMBLE}`;

    const effort = resolveCodexEffort(model, req.params?.reasoning?.effort);
    const summaryPref = String(settings?.codexReasoningSummary || 'auto');
    const summary = ['auto', 'concise', 'detailed', 'none'].includes(summaryPref) ? summaryPref : 'auto';
    const verbosityPref = String(settings?.codexVerbosity || 'medium');
    const verbosity = ['low', 'medium', 'high'].includes(verbosityPref) ? verbosityPref : 'medium';
    const stops = Array.isArray(req.params?.stop) ? req.params.stop.filter(s => typeof s === 'string' && s.length > 0) : [];

    const started = await server.request('thread/start', {
        model,
        cwd: getSafeCwd(),
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions,
        personality: 'none',
        developerInstructions: '',
        config: { model_verbosity: verbosity },
        modelProvider: 'openai',
    }, 60000);

    const threadId = started?.thread?.id;
    if (!threadId) {
        throw new LlmError('upstream', 'Codex app-server did not return a thread id', { status: 502, retryable: false });
    }

    const releaseThread = () => {
        server.request('thread/unsubscribe', { threadId }, 5000).catch(() => {});
    };

    const queue = [];
    let notifyQueue = null;
    const pushEvent = ev => {
        queue.push(ev);
        if (notifyQueue) {
            const r = notifyQueue;
            notifyQueue = null;
            r();
        }
    };

    let turnId = null;
    let interruptSent = false;
    let done = false;
    let usage = null;
    let turnError = null;
    const phases = new Map();
    const streamedItems = new Set();

    const sendInterrupt = () => {
        if (interruptSent || !turnId) return;
        interruptSent = true;
        server.request('turn/interrupt', { threadId, turnId }, 5000).catch(() => {});
    };

    const unsubscribe = server.subscribeThread(threadId, msg => {
        if (done) return;
        const p = msg.params ?? {};
        switch (msg.method) {
            case 'turn/started':
                if (!turnId && p.turn?.id) turnId = p.turn.id;
                break;
            case 'item/started': {
                const item = p.item ?? {};
                if (TOOL_ITEM_TYPES.has(item.type)) {
                    turnError = new LlmError('upstream', `Codex attempted a tool call (${item.type}) during roleplay; stopped.`, { status: 502 });
                    sendInterrupt();
                    done = true;
                    pushEvent({ type: 'done' });
                } else if (item.type === 'agentMessage' && item.id) {
                    phases.set(item.id, item.phase ?? null);
                }
                break;
            }
            case 'item/agentMessage/delta':
                if (!p.delta) break;
                streamedItems.add(p.itemId);
                if (phases.get(p.itemId) === 'commentary') {
                    pushEvent({ type: 'reasoning', text: p.delta });
                } else {
                    pushEvent({ type: 'text', text: p.delta });
                }
                break;
            case 'item/reasoning/summaryTextDelta':
            case 'item/reasoning/textDelta':
                if (p.delta) pushEvent({ type: 'reasoning', text: p.delta });
                break;
            case 'item/reasoning/summaryPartAdded':
                pushEvent({ type: 'reasoning', text: '\n\n' });
                break;
            case 'item/completed': {
                const item = p.item ?? {};
                if (item.type === 'agentMessage' && item.text && !streamedItems.has(item.id) && !streamedItems.has(undefined)) {
                    const phase = item.phase ?? phases.get(item.id) ?? null;
                    if (phase === 'commentary') pushEvent({ type: 'reasoning', text: item.text });
                    else pushEvent({ type: 'text', text: item.text });
                }
                break;
            }
            case 'thread/tokenUsage/updated': {
                const u = p.tokenUsage?.last ?? p.tokenUsage?.total;
                if (u) {
                    const inTok = u.inputTokens ?? 0;
                    const outTok = u.outputTokens ?? 0;
                    usage = {
                        prompt_tokens: inTok,
                        completion_tokens: outTok,
                        total_tokens: inTok + outTok,
                    };
                }
                break;
            }
            case 'error':
                if (!p.willRetry) {
                    turnError = classifyCodexTurnError(p.error, LlmError);
                }
                break;
            case 'turn/completed': {
                const turn = p.turn ?? {};
                if ((turn.status === 'failed' || turn.error) && !turnError) {
                    turnError = turn.error
                        ? classifyCodexTurnError(turn.error, LlmError)
                        : new LlmError('upstream', 'Codex turn failed', { status: 502 });
                }
                done = true;
                pushEvent({ type: 'done' });
                break;
            }
            case 'sigma/exit':
                turnError = new LlmError('upstream', p.error?.message ?? 'Codex app-server exited mid-turn', { status: 502 });
                done = true;
                pushEvent({ type: 'done' });
                break;
            default:
                break;
        }
    });

    const onAbort = () => {
        sendInterrupt();
        done = true;
        pushEvent({ type: 'done' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const foldedText = foldConversation(req.messages || [], { includeSystem: false });
    const input = [{ type: 'text', text: foldedText }];
    for (const img of current.images || []) {
        if (img.url) input.push({ type: 'image', url: img.url });
    }

    let fullText = '';
    let hitStop = false;

    try {
        const turn = await server.request('turn/start', {
            threadId,
            input,
            ...(effort ? { effort } : {}),
            summary,
        }, 60000);
        if (!turnId && turn?.turn?.id) turnId = turn.turn.id;

        while (!signal?.aborted) {
            while (queue.length > 0) {
                const ev = queue.shift();
                if (ev.type === 'reasoning' && ev.text) {
                    yield { reasoning: ev.text };
                } else if (ev.type === 'text' && ev.text) {
                    let chunk = ev.text;
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
                            if (allowed) yield { text: allowed };
                            hitStop = true;
                            sendInterrupt();
                            done = true;
                            break;
                        }
                    }
                    fullText += chunk;
                    yield { text: chunk };
                } else if (ev.type === 'done') {
                    break;
                }
            }
            if (done || hitStop) break;
            await new Promise(r => { notifyQueue = r; });
        }
    } finally {
        signal?.removeEventListener('abort', onAbort);
        unsubscribe();
        releaseThread();
    }

    if (signal?.aborted) return;
    if (turnError && !hitStop) throw turnError;

    yield { done: { finishReason: 'stop', ...(usage ? { usage } : {}) } };
}

export async function chatCodexCli(profile, req, settings, signal, LlmError) {
    let content = '';
    let reasoning = '';
    let finishReason = 'stop';
    let usage;
    for await (const part of streamCodexCli(profile, req, settings, signal, LlmError)) {
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

export async function codexStatus() {
    const bin = resolveCodexBinary();
    const version = detectCodexVersion();
    const home = sharedServer?.codexHome ?? resolveCodexHome();
    const auth = readCodexAuthSummary(home);
    let account = sharedServer?.lastAccount ?? null;

    if (bin && auth.present && !account) {
        try {
            const server = await getAppServer();
            const res = await server.request('account/read', { refreshToken: false }, 8000);
            if (res?.account) {
                account = {
                    type: res.account.type ?? null,
                    planType: res.account.planType ?? null,
                    email: res.account.email ?? null,
                };
                server.lastAccount = account;
            }
        } catch {
            // Ignore account/read failure
        }
    }

    return {
        installed: Boolean(bin),
        binaryPath: bin?.path ?? null,
        version,
        loggedIn: auth.present,
        authMode: account?.type ?? auth.mode ?? null,
        planType: account?.planType ?? null,
        rateLimits: sharedServer?.lastRateLimits ?? null,
    };
}
