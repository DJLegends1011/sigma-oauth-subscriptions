// Conversation partitioning, prefill continuation, and transcript folding shared by
// the Claude Code CLI and Codex CLI adapters.

export const TEXT_ONLY_PREAMBLE =
    'You are a conversational assistant inside a chat application. Reply with plain prose in the requested style. ' +
    'Do not use tools, do not run commands, do not browse, and do not create files — there is nothing to execute; ' +
    'just write the reply.';

export function textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(p => p && p.type === 'text' && typeof p.text === 'string')
            .map(p => p.text)
            .join('\n');
    }
    return '';
}

export function imagesOf(msg) {
    const out = [];
    if (Array.isArray(msg?.images)) {
        for (const i of msg.images) {
            if (i?.data && i?.mediaType) {
                out.push({
                    mediaType: i.mediaType,
                    data: i.data,
                    url: `data:${i.mediaType};base64,${i.data}`,
                });
            }
        }
    }
    if (Array.isArray(msg?.content)) {
        for (const p of msg.content) {
            if (p?.type !== 'image_url') continue;
            const url = p.image_url?.url ?? '';
            const m = url.match(/^data:(image\/[^;]+);base64,([A-Za-z0-9+/]+=*)$/);
            if (m) out.push({ mediaType: m[1], data: m[2], url });
        }
    }
    return out;
}

export function buildPrefillContinuation(prefill) {
    const normalized = String(prefill ?? '').trimEnd();
    if (!normalized.trim()) return '[Continue your last message — write only what comes next.]';
    return [
        '[Continue your last message. It currently ends with:',
        `"${normalized}"`,
        'Write only what comes next — do not repeat what is already written, and keep the same voice and format.]',
    ].join('\n');
}

/**
 * Partition Project Sigma messages into:
 * - system: leading system messages joined
 * - turns: subsequent user/assistant turns (in-chat system messages become user turns in place, adjacent user turns merged)
 * - prefill: trailing assistant text if the conversation ends on an assistant message
 */
export function partitionMessages(messages) {
    const list = (Array.isArray(messages) ? messages : []).filter(m => m && typeof m === 'object' && typeof m.role === 'string');
    let i = 0;
    const sys = [];
    while (i < list.length && list[i].role === 'system') {
        const t = textOf(list[i].content);
        if (t.trim()) sys.push(t);
        i++;
    }

    const turns = [];
    for (const m of list.slice(i)) {
        const text = textOf(m.content);
        const images = imagesOf(m);
        if (!text.trim() && !images.length) continue;
        const fromSystem = m.role === 'system' || m.role === 'developer';
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        const prev = turns[turns.length - 1];
        if (role === 'user' && prev && prev.role === 'user') {
            prev.text = [prev.text, text].filter(Boolean).join('\n\n');
            prev.images.push(...images);
            prev.segments.push({ text, fromSystem });
            prev.fromSystem = prev.fromSystem && fromSystem;
            continue;
        }
        turns.push({
            role,
            text,
            images: [...images],
            fromSystem,
            segments: role === 'user' ? [{ text, fromSystem }] : [],
        });
    }

    const last = list[list.length - 1];
    const prefill = last && last.role === 'assistant' && i < list.length ? textOf(last.content) : null;
    return {
        system: sys.length ? sys.join('\n\n') : '',
        turns,
        prefill,
    };
}

export function splitForResume(messages) {
    const { system, turns, prefill } = partitionMessages(messages);
    if (!turns.length) {
        return {
            system,
            history: [],
            current: { role: 'user', text: '[Start]', images: [], fromSystem: true, segments: [] },
        };
    }
    const last = turns[turns.length - 1];
    if (last.role === 'assistant') {
        return {
            system,
            history: turns,
            current: {
                role: 'user',
                text: buildPrefillContinuation(prefill ?? last.text),
                images: [],
                fromSystem: true,
                segments: [],
            },
        };
    }
    return {
        system,
        history: turns.slice(0, -1),
        current: last,
    };
}

export function foldConversation(messages, { includeSystem = false } = {}) {
    const { system, history, current } = splitForResume(messages);
    const sections = [];
    if (includeSystem && system) {
        sections.push(`<system_instructions>\n${system}\n</system_instructions>`);
    }
    if (history.length) {
        const lines = [];
        for (const m of history) {
            const imgNote = m.images?.length ? ' [image attached earlier]' : '';
            if (m.role === 'assistant') {
                if (m.text.trim()) lines.push(`Assistant: ${m.text.trim()}`);
            } else {
                const segs = Array.isArray(m.segments) ? m.segments : [];
                const mixed = segs.some(s => s.fromSystem) && segs.some(s => !s.fromSystem);
                if (mixed) {
                    const parts = [];
                    for (const s of segs) {
                        const t = String(s.text ?? '').trim();
                        if (!t) continue;
                        parts.push(s.fromSystem ? t : `User: ${t}`);
                    }
                    lines.push(parts.join('\n\n') + imgNote);
                } else if (m.fromSystem) {
                    lines.push(m.text.trim());
                } else {
                    lines.push(`User: ${m.text.trim()}${imgNote}`);
                }
            }
        }
        if (lines.length) sections.push(`<conversation_history>\n${lines.join('\n\n')}\n</conversation_history>`);
    }

    if (current.fromSystem) {
        sections.push(current.text || '[Start]');
    } else {
        const segs = Array.isArray(current.segments) ? current.segments : [];
        const sysNotes = segs.filter(s => s.fromSystem && String(s.text ?? '').trim()).map(s => String(s.text).trim());
        const userTexts = segs.filter(s => !s.fromSystem && String(s.text ?? '').trim()).map(s => String(s.text).trim());
        if (sysNotes.length && userTexts.length) {
            sections.push(`<post_history_instructions>\n${sysNotes.join('\n\n')}\n</post_history_instructions>`);
            sections.push(`User: ${userTexts.join('\n\n')}`);
        } else {
            sections.push(`User: ${current.text || '[Start]'}`);
        }
        sections.push('Reply as Assistant only — one reply, in character, without speaking for User.');
    }
    return sections.join('\n\n');
}
