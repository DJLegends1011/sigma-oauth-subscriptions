// Antigravity CLI (`agy`) & CloudCode OAuth Subscription adapter for Project Sigma.
// Supports both:
//   - "direct" mode (legacy compatibility): Calls `daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`
//     identifying this extension and the installed CLI version, with the OAuth token from `~/.gemini/antigravity-cli/antigravity-oauth-token`
//     with only the supplied RP prompt/history, samplers and images. Backend access is not guaranteed.
//   - "cli" mode: Spawns `agy --input-format stream-json --output-format stream-json` in an isolated temp dir
//     and cleans up the ephemeral conversation entry when done.

import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import {
    readFileSync,
    writeFileSync,
    renameSync,
    chmodSync,
    unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { partitionMessages } from './messages.js';
import { resolveAgyBinary } from './agy-executable.js';
import { agyClientCandidates } from './agy-oauth-client.js';
export { resolveAgyBinary } from './agy-executable.js';
import { streamIsolatedAgy, isolatedAgyModels, isolatedAgyStatus } from './isolated-antigravity.js';

// Gemini 3 names minimal, low, medium and high; none cannot switch thinking off there, so it is the lowest level.
// A custom word goes up as typed and Gemini refuses it, which the connection's Test shows.
const GEMINI_LEVEL = { none: 'MINIMAL', xhigh: 'HIGH', max: 'HIGH' };
const geminiLevel = (effort) => GEMINI_LEVEL[effort] || String(effort).toUpperCase();

const CLOUDCODE_BASE = 'https://daily-cloudcode-pa.googleapis.com/v1internal';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedProject = null;

let modelCache = { at: 0, models: null, rawMap: null };

export function detectAgyVersion() {
    const bin = resolveAgyBinary();
    if (!bin) return null;
    try {
        const out = execFileSync(bin.command, [...bin.args, '--version'], {
            encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
            env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }, windowsHide: true,
        }).trim();
        return out.match(/^(?:Antigravity(?: CLI)?[ /v]*)?(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/im)?.[1] || null;
    } catch { return null; }
}
function agyUserAgent() {
    const ver = detectAgyVersion();
    if (!ver) throw new Error('Cannot determine installed Antigravity CLI version; no fallback identity is sent.');
    return `sigma-oauth-subscriptions/1.0.0 (installed-agy/${ver}; ${process.platform}/${process.arch})`;
}
export function agyError(value, LlmError, status = null) {
    if (typeof value === 'string') { try { const parsed = JSON.parse(value); value = parsed.error || parsed; } catch {} }
    status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    const detail = typeof value === 'string' ? value : JSON.stringify(value);
    const message = `Antigravity${status ? ` HTTP ${status}` : ''}: ${detail || 'unknown failure'}`;
    const kind = status === 429 || /RESOURCE_EXHAUSTED|quota.{0,30}(?:exhaust|exceed|reached)|\b429\b/i.test(message) ? 'quota'
        : status === 401 || status === 403 || /UNAUTHENTICATED|oauth|authentication|invalid.grant/i.test(message) ? 'auth' : /not advertised by CloudCode/.test(message) ? 'bad_request' : 'upstream';
    const error = new LlmError(kind, message.slice(0, 2000), { status: status || (kind === 'quota' ? 429 : kind === 'auth' ? 401 : kind === 'bad_request' ? 400 : 502), retryable: false });
    if (value && typeof value === 'object') error.code = value.error_code || value.code || value.status || value.type;
    return error;
}
export function isAgyServiceRejection(text) {
    return /^This version of Antigravity is no longer supported\./i.test(text.trim());
}
export function agyDataDir() {
    return process.env.AGY_DATA_DIR || join(homedir(), '.gemini', 'antigravity-cli');
}

function tokenFilePath() {
    return join(agyDataDir(), 'antigravity-oauth-token');
}

let cachedKeyringRaw = null;
let cachedKeyringAt = 0;
const KEYRING_CACHE_TTL_MS = 60 * 1000;

function readWindowsCredManSecret(target) {
    if (process.platform !== 'win32') return null;
    try {
        const script = [
            'Add-Type -TypeDefinition @"',
            'using System; using System.Runtime.InteropServices; using System.Text;',
            'public class SigmaCred {',
            '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
            '  public struct CREDENTIAL {',
            '    public uint Flags; public uint Type; public string TargetName; public string Comment;',
            '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
            '    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;',
            '    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;',
            '  }',
            '  [DllImport("Advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
            '  public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);',
            '  [DllImport("Advapi32.dll", SetLastError = true)]',
            '  public static extern void CredFree(IntPtr cred);',
            '  public static string Get(string t) {',
            '    IntPtr ptr; if (!CredRead(t, 1, 0, out ptr)) return null;',
            '    try {',
            '      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));',
            '      byte[] b = new byte[c.CredentialBlobSize];',
            '      Marshal.Copy(c.CredentialBlob, b, 0, (int)c.CredentialBlobSize);',
            '      return Encoding.UTF8.GetString(b);',
            '    } finally { CredFree(ptr); }',
            '  }',
            '}',
            '"@',
            `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
            `$s = [SigmaCred]::Get(${JSON.stringify(target)})`,
            `if ($s) { [Console]::Write($s) }`,
        ].join('\n');
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            encoding: 'utf8',
            timeout: 8000,
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
        });
        return out && out.trim() ? JSON.parse(out) : null;
    } catch {
        return null;
    }
}

function writeWindowsCredManSecret(target, userName, jsonString) {
    if (process.platform !== 'win32') return false;
    try {
        const b64 = Buffer.from(jsonString, 'utf8').toString('base64');
        const script = [
            'Add-Type -TypeDefinition @"',
            'using System; using System.Runtime.InteropServices; using System.Text;',
            'public class SigmaCredWrite {',
            '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
            '  public struct CREDENTIAL {',
            '    public uint Flags; public uint Type; public string TargetName; public string Comment;',
            '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
            '    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;',
            '    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;',
            '  }',
            '  [DllImport("Advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
            '  public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);',
            '  public static bool Set(string target, string user, byte[] bytes) {',
            '    IntPtr blob = Marshal.AllocCoTaskMem(bytes.Length);',
            '    try {',
            '      Marshal.Copy(bytes, 0, blob, bytes.Length);',
            '      CREDENTIAL c = new CREDENTIAL();',
            '      c.Type = 1; c.TargetName = target; c.UserName = user;',
            '      c.CredentialBlobSize = (uint)bytes.Length; c.CredentialBlob = blob; c.Persist = 2;',
            '      return CredWrite(ref c, 0);',
            '    } finally { Marshal.FreeCoTaskMem(blob); }',
            '  }',
            '}',
            '"@',
            `$bytes = [Convert]::FromBase64String(${JSON.stringify(b64)})`,
            `if (-not [SigmaCredWrite]::Set(${JSON.stringify(target)}, ${JSON.stringify(userName)}, $bytes)) { exit 1 }`,
        ].join('\n');
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            encoding: 'utf8',
            timeout: 8000,
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
        });
        return true;
    } catch {
        return false;
    }
}

function parseAgyTokenPayload(raw, source = 'file') {
    if (!raw || typeof raw !== 'object') return null;
    const tok = typeof raw.token === 'string' ? JSON.parse(raw.token) : raw.token;
    if (!tok || typeof tok !== 'object') return null;
    let email = typeof raw.id_token_email === 'string' && raw.id_token_email ? raw.id_token_email : null;
    if (!email && typeof raw.id_token === 'string') {
        try {
            const payload = JSON.parse(Buffer.from(raw.id_token.split('.')[1], 'base64url').toString('utf8'));
            email = payload.email || null;
        } catch { /* ignore */ }
    }
    return {
        raw,
        source,
        accessToken: tok?.access_token ?? null,
        refreshToken: tok?.refresh_token ?? null,
        expiryMs: tok?.expiry ? Date.parse(tok.expiry) || 0 : 0,
        email,
    };
}

export function readAgyStoredToken({ forceKeyring = false } = {}) {
    try {
        const raw = JSON.parse(readFileSync(tokenFilePath(), 'utf8'));
        const parsed = parseAgyTokenPayload(raw, 'file');
        if (parsed?.accessToken) return parsed;
    } catch { /* fall through to OS keyring */ }

    if (process.platform === 'win32') {
        const now = Date.now();
        if (forceKeyring || !cachedKeyringRaw || now - cachedKeyringAt > KEYRING_CACHE_TTL_MS) {
            const secret = readWindowsCredManSecret('gemini:antigravity');
            if (secret) {
                cachedKeyringRaw = secret;
                cachedKeyringAt = now;
            }
        }
        if (cachedKeyringRaw) {
            try {
                const parsed = parseAgyTokenPayload(cachedKeyringRaw, 'keyring');
                if (parsed?.accessToken) return parsed;
            } catch { /* ignore */ }
        }
    }
    return null;
}

let inflightRefresh = null;
let acceptedClient = null;

// Google answers invalid_client / unauthorized_client for a pair that is not the refresh
// token's client; any other failure ends the attempt.
async function requestAgyRefresh(refreshToken) {
    const candidates = agyClientCandidates();
    if (acceptedClient) candidates.sort((a, b) => (b.id === acceptedClient.id && b.secret === acceptedClient.secret) - (a.id === acceptedClient.id && a.secret === acceptedClient.secret));
    for (const client of candidates) {
        const res = await fetch(GOOGLE_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: client.id,
                client_secret: client.secret,
                refresh_token: refreshToken,
                grant_type: 'refresh_token',
            }),
            signal: AbortSignal.timeout(15000),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.access_token) {
            acceptedClient = client;
            return data;
        }
        if (data.error !== 'invalid_client' && data.error !== 'unauthorized_client') return null;
    }
    return null;
}

export function refreshAgyOAuthToken() {
    if (inflightRefresh) return inflightRefresh;
    inflightRefresh = (async () => {
        const stored = readAgyStoredToken({ forceKeyring: true });
        if (!stored?.refreshToken) return false;
        try {
            const data = await requestAgyRefresh(stored.refreshToken);
            if (!data) return false;
            if (!data.access_token) return false;

            const path = tokenFilePath();
            const latest = readAgyStoredToken() ?? stored;
            const tokenWasString = typeof latest.raw.token === 'string';
            const inner = tokenWasString ? JSON.parse(latest.raw.token) : { ...latest.raw.token };
            inner.access_token = data.access_token;
            if (data.refresh_token) inner.refresh_token = data.refresh_token;
            const expDate = new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000);
            inner.expiry = expDate.toISOString();

            const updated = {
                ...latest.raw,
                token: tokenWasString ? JSON.stringify(inner) : inner,
                ...(data.id_token ? { id_token: data.id_token } : {}),
            };
            if (latest.source === 'keyring' && process.platform === 'win32') {
                cachedKeyringRaw = updated;
                cachedKeyringAt = Date.now();
                writeWindowsCredManSecret('gemini:antigravity', 'antigravity', JSON.stringify(updated));
                return true;
            }
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
        source: stored.source || 'file',
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
        expiryMs: stored.expiryMs,
        email: stored.email,
    };
}

async function resolveProjectAndTier(accessToken) {
    if (cachedProject?.token === accessToken && Date.now() - cachedProject.at < MODEL_CACHE_TTL_MS) return cachedProject.info;
    const res = await fetch(`${CLOUDCODE_BASE}:loadCodeAssist`, {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'User-Agent': agyUserAgent() },
        body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }), signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw Object.assign(new Error(`loadCodeAssist HTTP ${res.status}: ${(await res.text()).slice(0, 1500)}`), { status: res.status });
    const data = await res.json();
    const project = typeof data.cloudaicompanionProject === 'string' ? data.cloudaicompanionProject : data.cloudaicompanionProject?.id;
    if (!project) throw new Error('CloudCode returned no project; direct mode is unavailable for this account.');
    const info = { project, tierName: data.paidTier?.name || data.currentTier?.name || 'Antigravity' };
    cachedProject = { token: accessToken, at: Date.now(), info };
    return info;
}
export async function discoverAgyModels({ force = false, profile } = {}) {
    const auth = await getAgyAuthToken(profile);
    if (!force && modelCache.token === auth?.accessToken && modelCache.models && Date.now() - modelCache.at < MODEL_CACHE_TTL_MS) {
        return modelCache;
    }

    const byId = new Map();
    let rawMap = {};

    if (!auth?.accessToken) throw new Error('Antigravity OAuth login required');
    if (auth?.accessToken) {
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
            if (!res.ok) throw Object.assign(new Error(`fetchAvailableModels HTTP ${res.status}: ${(await res.text()).slice(0, 1500)}`), { status: res.status });
            {
                const data = await res.json();
                rawMap = data.models || {};
                for (const [id, m] of Object.entries(rawMap)) {
                    if (/^(chat_|tab_)/.test(id)) continue;
                    byId.set(id, {
                        id,
                        contextLength: Number(m.maxTokens) || null,
                        vision: m.supportsImages === true,
                        quotaInfo: m.quotaInfo || null,
                        displayName: m.displayName || id,
                    });
                }
            }

    }

    const models = [...byId.values()];
    modelCache = { at: Date.now(), models, rawMap, token: auth.accessToken };
    return modelCache;
}

export async function listAgyCliModels(profile, settings = {}, signal) {
    if (settings.antigravityMode !== 'direct') return isolatedAgyModels(signal);
    const { models } = await discoverAgyModels({ profile });
    return models.map(({ id, contextLength, vision }) => ({ id, contextLength, vision }));
}

export function resolveCloudCodeModel(requestedId, cache) {
    const id = String(requestedId || '').trim();
    if (id && Object.hasOwn(cache?.rawMap || {}, id)) return id;
    throw new Error(`Model "${id || '(unset)'}" is not advertised by CloudCode. Refresh models and select an exact ID; quota pools do not imply model availability.`);
}
export function buildCloudCodeContents(turns) {
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
        if (!parts.length) continue;

        const prev = contents[contents.length - 1];
        if (prev && prev.role === role) {
            prev.parts.push(...parts);
        } else {
            contents.push({ role, parts });
        }
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

    let cache;
    try { cache = await discoverAgyModels({ profile }); } catch (err) {
        if (err.status === 401 && !retriedAuth && auth.source !== 'profile' && await refreshAgyOAuthToken()) {
            yield* streamAgyDirect(profile, req, signal, LlmError, true); return;
        }
        throw err;
    }
    const { project } = await resolveProjectAndTier(auth.accessToken);
    const requestedModel = req.model || profile.model || 'claude-sonnet-5-5-medium';
    const targetModel = resolveCloudCodeModel(requestedModel, cache);

    const { system, turns } = partitionMessages(req.messages || []);
    const sysText = system;
    const contents = buildCloudCodeContents(turns);

    const wantsThinking = req.params?.reasoning?.enabled !== false && Boolean(req.params?.reasoning || /thinking/i.test(targetModel)) && cache.rawMap[targetModel]?.supportsThinking !== false;
    const requestedMax = req.params?.maxTokens ?? 8192;
    if (!Number.isInteger(requestedMax) || requestedMax <= 0) throw new LlmError('bad_request', 'Antigravity maxTokens must be a positive integer', { status: 400, retryable: false });
    const generationConfig = {
        maxOutputTokens: requestedMax,
    };
    if (typeof req.params?.temperature === 'number') generationConfig.temperature = req.params.temperature;
    if (typeof req.params?.topP === 'number') generationConfig.topP = req.params.topP;
    if (Array.isArray(req.params?.stop) && req.params.stop.length > 0) {
        generationConfig.stopSequences = req.params.stop;
    }
    if (wantsThinking) {
        generationConfig.thinkingConfig = { includeThoughts: true,
            ...(typeof req.params?.reasoning?.budgetTokens === 'number' ? { thinkingBudget: req.params.reasoning.budgetTokens } : {}),
            ...(/^gemini-(?:[3-9]|[1-9][0-9])/.test(targetModel) && req.params?.reasoning?.effort && req.params?.reasoning?.budgetTokens == null
                ? { thinkingLevel: geminiLevel(req.params.reasoning.effort) } : {}),
        };
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
                ...(sysText ? { systemInstruction: { parts: [{ text: sysText }] } } : {}),
                contents,
                generationConfig,
            },
        }),
        signal,
    });

    if (res.status === 401 && !retriedAuth && (auth.source === 'file' || auth.source === 'keyring')) {
        const ok = await refreshAgyOAuthToken();
        if (ok) {
            yield* streamAgyDirect(profile, req, signal, LlmError, true);
            return;
        }
    }

    if (!res.ok) throw agyError(await res.text().catch(() => ''), LlmError, res.status);

    let finishReason = 'stop';
    let usage = null;
    let completed = false;
    let pendingText = '';
    let textStarted = false;

    for await (const parsed of readCloudCodeEvents(res.body)) {
        signal?.throwIfAborted();
        const resp = parsed.response || parsed;
        if (parsed.error || resp.error) throw agyError(parsed.error || resp.error, LlmError, (parsed.error || resp.error).code);
        const cand = resp.candidates?.[0];
        if (cand?.finishReason) completed = true;
        if (resp.promptFeedback?.blockReason || (cand?.finishReason && !['STOP', 'MAX_TOKENS'].includes(cand.finishReason))) throw agyError(resp.promptFeedback || cand, LlmError);
        const parts = cand?.content?.parts;
        const serviceText = parts?.filter(p => !p.thought).map(p => p.text || '').join('') || '';
        if (isAgyServiceRejection(serviceText)) throw agyError(serviceText, LlmError, 400);
        if (Array.isArray(parts)) {
            for (const p of parts) {
                if (p.thought && typeof p.text === 'string' && p.text) {
                    yield { reasoning: p.text };
                } else if (!p.thought && typeof p.text === 'string' && p.text) {
                    if (!textStarted) {
                        pendingText += p.text;
                        if (isAgyServiceRejection(pendingText)) throw agyError(pendingText, LlmError, 400);
                        if ('This version of Antigravity is no longer supported.'.toLowerCase().startsWith(pendingText.trim().toLowerCase())) continue;
                        textStarted = true;
                        yield { text: pendingText };
                        pendingText = '';
                    } else yield { text: p.text };
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

    if (!completed) throw agyError('CloudCode stream ended without a terminal candidate', LlmError);
    if (pendingText) yield { text: pendingText };
    yield { done: { finishReason, ...(usage ? { usage } : {}) } };
}

async function* streamAgySubprocess(profile, req, signal, LlmError) {
    yield* streamIsolatedAgy(profile, req, signal, LlmError);
}

export async function* streamAgyCli(profile, req, settings, signal, LlmError) {
    try {
        signal?.throwIfAborted();
        if (settings?.antigravityMode !== 'direct') {
            yield* streamAgySubprocess(profile, req, signal, LlmError);
        } else {
            yield* streamAgyDirect(profile, req, signal, LlmError);
        }
    } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError' || err?.kind) throw err;
        if (err?.name === 'TimeoutError') throw new LlmError('timeout', 'Antigravity request timed out', { retryable: false });
        if (err instanceof TypeError && /fetch|network/i.test(err.message)) throw new LlmError('network', `Antigravity network failure: ${err.cause?.code || err.message}`, { retryable: false });
        throw agyError(err?.message || err, LlmError, err?.status);
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

export async function agyStatus(settings = {}) {
    if (settings.antigravityMode !== 'direct') return isolatedAgyStatus();
    const bin = resolveAgyBinary();
    const version = detectAgyVersion();
    const auth = await getAgyAuthToken();
    const loggedIn = Boolean(auth?.accessToken);

    let tierName = null;
    const pools = parseAgyQuotaPools({});
    let statusError = null;

    if (auth?.accessToken) {
        try {
            const info = await resolveProjectAndTier(auth.accessToken);
            tierName = info.tierName;
            const quota = await discoverAgyQuotas(auth.accessToken, info.project);
            pools.splice(0, pools.length, ...parseAgyQuotaPools({}, quota));
            statusError = quota.errors.join('; ') || null;
        } catch (err) { statusError = err.message; }
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
        error: statusError,
    };
}

export async function discoverAgyQuotas(accessToken, project) {
    const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'User-Agent': agyUserAgent() };
    const results = await Promise.allSettled(['retrieveUserQuota', 'retrieveUserQuotaSummary'].map(async action => {
        const res = await fetch(`${CLOUDCODE_BASE}:${action}`, { method: 'POST', headers, body: JSON.stringify({ project }), signal: AbortSignal.timeout(12000) });
        if (!res.ok) throw new Error(`${action} HTTP ${res.status}: ${(await res.text()).slice(0, 1000)}`);
        return res.json();
    }));
    if (results.every(r => r.status === 'rejected')) throw results[0].reason;
    return { ...(results[0].value || {}), ...(results[1].value || {}),
        errors: results.filter(r => r.status === 'rejected').map(r => r.reason.message) };
}

export function parseAgyQuotaPools(rawMap, quota = {}) {
    return [
        ['Gemini Flash / Pro', id => /gemini/i.test(id) && !/argon/i.test(id)],
        ['Claude / GPT', id => /claude|gpt/i.test(id)],
        ['Gemini 4 Argon', id => /argon/i.test(id)],
    ].map(([name, matches]) => {
        const groups = (quota.groups || []).filter(g => matches(g.displayName || g.groupId || ''));
        const summary = groups.flatMap(g => g.buckets || []);
        const buckets = (quota.buckets || []).filter(b => matches(b.modelId || ''));
        const models = Object.entries(rawMap).filter(([id]) => matches(id)).map(([, m]) => m.quotaInfo);
        const source = summary.length ? summary : buckets.length ? buckets : models;
        const windows = source.filter(q => typeof q?.remainingFraction === 'number' && Number.isFinite(q.remainingFraction)).map(q => {
            const remaining = Math.max(0, Math.min(1, q.remainingFraction));
            return { window: q.window || null, remainingPct: Math.round(remaining * 1000) / 10,
                usedPct: Math.round((1 - remaining) * 1000) / 10, resetTime: q.resetTime || null, exhausted: remaining === 0 };
        });
        if (!windows.length) return { name, available: false, remainingPct: null, usedPct: null, resetTime: null, exhausted: false, windows: [] };
        const limiting = windows.reduce((a, b) => a.remainingPct <= b.remainingPct ? a : b);
        return { name, available: true, ...limiting, windows };
    });
}

/** SSE frames may span lines or network chunks. Never silently discard malformed events. */
export async function* readCloudCodeEvents(body) {
    if (!body) throw new Error('CloudCode returned no response body');
    const input = Readable.fromWeb(body);
    const lines = createInterface({ input, crlfDelay: Infinity });
    let data = [];
    const parse = () => {
        const text = data.join('\n'); data = [];
        if (!text || text === '[DONE]') return null;
        try { return JSON.parse(text); } catch { throw new Error('Malformed CloudCode SSE event'); }
    };
    try {
        for await (const line of lines) {
            if (line === '') { const event = parse(); if (event) yield event; }
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length) { const event = parse(); if (event) yield event; }
    } finally { lines.close(); input.destroy(); }
}
