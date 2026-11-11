// Sigma interface for LukaTheHero's isolated Antigravity subscription driver.
// Source and adaptations are recorded in subscriptions-reference/UPSTREAM.md.
import { runAgy, agyBilling, agyLaunchSpec, agyVersion, isolationSupport, CHAT_AGENT_NAME } from './subscriptions-reference/gemini/agy.js';
import { listGeminiModels, resolveGeminiModel, geminiCatalog } from './subscriptions-reference/gemini/models.js';
import { foldConversationForAgy } from './subscriptions-reference/gemini/prompt.js';
import { splitConversation } from './subscriptions-reference/common/messages.js';
import { CompletionWriter } from './subscriptions-reference/common/completion.js';
import { toOpenAiUsage } from './subscriptions-reference/common/sse.js';

function upstreamMessages(messages) {
    return (messages || []).map(message => {
        if (!message.images?.length) return message;
        const content = Array.isArray(message.content) ? [...message.content] : [{ type: 'text', text: message.content || '' }];
        for (const image of message.images) {
            content.push({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } });
        }
        return { ...message, content };
    });
}

function sigmaError(error, LlmError) {
    if (error.name === 'AbortError') return error;
    const status = error.httpStatus || 502;
    const kind = status === 429 || /RESOURCE_EXHAUSTED|quota.*(?:exhaust|reached)/i.test(error.message) ? 'quota'
        : status === 401 || status === 403 || /OAuth|authentication required/i.test(error.message) ? 'auth'
        : status === 400 ? 'bad_request' : status === 504 ? 'timeout' : 'upstream';
    return new LlmError(kind, error.message, { status: kind === 'quota' ? 429 : status, retryable: false });
}

export async function* streamIsolatedAgy(profile, request, signal, LlmError) {
    if (agyBilling().subscriptionBlocked) {
        throw new LlmError('bad_request', 'Antigravity settings select API-key billing. Configure the CLI for Google sign-in to use this subscription connection.', { status: 400, retryable: false });
    }
    const messages = upstreamMessages(request.messages);
    const { currentMessage, prefill } = splitConversation(messages);
    if (Array.isArray(currentMessage?.content) && currentMessage.content.some(part => part.type === 'image_url')) {
        throw new LlmError('bad_request', 'Antigravity CLI headless input is text-only. Use a Sigma API connection for current-turn images.', { status: 400, retryable: false });
    }
    let model;
    try {
        model = resolveGeminiModel(request.model || profile.model || 'claude-sonnet-5-5-medium', request.params?.reasoning?.effort, geminiCatalog());
    } catch (error) {
        throw sigmaError(error, LlmError);
    }
    const folded = foldConversationForAgy(messages);
    const events = [];
    let notify;
    const push = event => { events.push(event); notify?.(); };
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let complete = false;
    let failure;
    let finish;
    // Luka's writer handles stops and prefill echoes. Translate its output to Sigma.
    const response = {
        writableEnded: false, destroyed: false, headersSent: false,
        setHeader() {},
        flushHeaders() { this.headersSent = true; },
        write(line) {
            if (!line.startsWith('data: ') || line.startsWith('data: [DONE]')) return true;
            const event = JSON.parse(line.slice(6));
            const choice = event.choices?.[0];
            if (choice?.delta?.content) push({ text: choice.delta.content });
            if (choice?.delta?.reasoning_content) push({ reasoning: choice.delta.reasoning_content });
            if (choice?.finish_reason) finish = { finishReason: choice.finish_reason, ...(event.usage ? { usage: event.usage } : {}) };
            return true;
        },
        end() { this.writableEnded = true; },
    };
    const writer = new CompletionWriter({ res: response, stream: true, model: model.agyModel, stops: request.params?.stop || [] });
    if (prefill) writer.setPrefill(prefill);
    const operation = runAgy({
        prompt: folded.prompt, agentSections: folded.agentSections,
        model: model.agyModel, effort: model.agyEffort, allowApiKey: false,
        signal: controller.signal,
        onText: delta => writer.pushText(delta),
        onReasoning: delta => writer.pushReasoning(delta),
    }).then(result => {
        const usage = result.usage;
        writer.flushTail();
        writer.finish({ usage: usage ? toOpenAiUsage({
            input: Math.max(0, (usage.input_tokens || 0) - (usage.cache_read_tokens || 0)),
            output: usage.output_tokens || 0, cacheRead: usage.cache_read_tokens || 0,
            reasoning: usage.thinking_tokens || 0,
        }) : null });
    }).catch(error => { failure = sigmaError(error, LlmError); }).finally(() => { complete = true; notify?.(); });
    try {
        while (!complete || events.length) {
            if (!events.length && !complete) await new Promise(resolve => { notify = resolve; });
            while (events.length) yield events.shift();
        }
        if (failure) throw failure;
        yield { done: finish || { finishReason: 'stop' } };
    } finally {
        signal?.removeEventListener('abort', abort);
        controller.abort();
        await operation;
    }
}

export async function isolatedAgyModels(signal) {
    signal?.throwIfAborted();
    const models = await listGeminiModels();
    signal?.throwIfAborted();
    return models.map(model => ({ id: model.id }));
}

export async function isolatedAgyStatus() {
    const binary = agyLaunchSpec();
    const version = await agyVersion(binary);
    const billing = agyBilling();
    const isolation = isolationSupport(version);
    return {
        installed: Boolean(binary), binaryPath: binary?.path || null, version,
        loggedIn: null, authState: 'unknown',
        subscriptionReady: binary && !billing.subscriptionBlocked && isolation.ok !== false ? null : false,
        billing: billing.billing, isolation: { agent: CHAT_AGENT_NAME, ...isolation },
        message: billing.subscriptionBlocked ? 'CLI settings select API-key billing.' : 'Google sign-in is checked by the CLI on the next generation.',
        pools: ['Gemini Flash / Pro', 'Claude / GPT', 'Gemini 4 Argon'].map(name => ({ name, available: false, remainingPct: null, resetTime: null })),
    };
}
