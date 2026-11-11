// Extracted verbatim from LukaTheHero/SillyTavern-Subscriptions lib/gemini/chat.js.
// See ../LICENSE and ../UPSTREAM.md.
import { AGY_MAX_STDIN_BYTES, AGY_MAX_TOTAL_BYTES, CHAT_AGENT_MD, CHAT_AGENT_NAME, buildChatAgentMd } from './agy.js';
import { foldConversation, splitConversation, formatHistoryTurnForFold, formatCurrentTurnForFold } from '../common/messages.js';
const utf8Bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

function splitUtf8Tail(text, maxTailBytes) {
    const str = String(text ?? '');
    if (maxTailBytes <= 0) return { head: str, tail: '' };
    if (utf8Bytes(str) <= maxTailBytes) return { head: '', tail: str };
    const buf = Buffer.from(str, 'utf8');
    let start = buf.length - maxTailBytes;
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
    const nl = buf.indexOf(0x0a, start);
    if (nl !== -1 && nl - start <= 2048 && nl + 1 < buf.length) start = nl + 1;
    return {
        head: buf.subarray(0, start).toString('utf8').trimEnd(),
        tail: buf.subarray(start).toString('utf8'),
    };
}

function sliceUtf8Head(text, maxHeadBytes) {
    const str = String(text ?? '');
    if (maxHeadBytes <= 0) return '';
    if (utf8Bytes(str) <= maxHeadBytes) return str;
    const buf = Buffer.from(str, 'utf8');
    let end = maxHeadBytes;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    return buf.subarray(0, end).toString('utf8');
}

/**
 * Fold and partition an OpenAI messages[] array for agy so that:
 *  1. STDIN (`prompt`) never exceeds `maxStdinBytes` (180 KB, below agy's
 *     192,000-byte MaxTokensPerUserInputStep tail-truncation limit).
 *  2. Combined `agent.md` + `prompt` never exceeds `maxTotalBytes` (720 KB,
 *     below agy's ~765,000-byte TruncationThresholdTokens ceiling).
 *  3. When the full folded conversation fits within `maxStdinBytes`, all of it
 *     stays in `prompt` with no extra `agentSections`.
 *  4. When it exceeds `maxStdinBytes`, `<system_instructions>` and any older
 *     history turns that do not fit alongside the newest history turns +
 *     current turn in `prompt` are spilled into `agentSections` in strict
 *     chronological order. If total size still exceeds `maxTotalBytes`, the
 *     oldest history turns are dropped first.
 *
 * @param {object[]} messages
 * @param {{ userLabel?: string, assistantLabel?: string, maxStdinBytes?: number, maxTotalBytes?: number }} [opts]
 * @returns {{ prompt: string, agentSections: Array<{ heading: string, content: string }>, spilledToAgent: boolean, droppedHistoryTurns: number }}
 */
export function foldConversationForAgy(messages, opts = {}) {
    const {
        userLabel = 'User',
        assistantLabel = 'Assistant',
        maxStdinBytes = AGY_MAX_STDIN_BYTES,
        maxTotalBytes = AGY_MAX_TOTAL_BYTES,
    } = opts;
    const fullFolded = foldConversation(messages, { includeSystem: true, userLabel, assistantLabel });
    if (utf8Bytes(fullFolded) <= maxStdinBytes && utf8Bytes(CHAT_AGENT_MD) + utf8Bytes(fullFolded) <= maxTotalBytes) {
        return { prompt: fullFolded, agentSections: [], spilledToAgent: false, droppedHistoryTurns: 0 };
    }

    const { system, history, current, prefill, currentMessage } = splitConversation(messages);
    const lines = [];
    for (const m of history) {
        const formatted = formatHistoryTurnForFold(m, { userLabel, assistantLabel });
        if (formatted) lines.push(formatted);
    }

    const currentParts = formatCurrentTurnForFold({ current, prefill, currentMessage, userLabel, assistantLabel });
    const currentBlock = currentParts.join('\n\n');

    let sysText = system ? String(system) : '';
    let currentOverflow = '';
    let stdinCurrent = currentBlock;
    let earlierLines = [];
    let recentLines = [];

    if (utf8Bytes(currentBlock) > maxStdinBytes) {
        const split = splitUtf8Tail(currentBlock, maxStdinBytes);
        currentOverflow = split.head;
        stdinCurrent = split.tail;
        earlierLines = [...lines];
    } else {
        const wrapperBytes = utf8Bytes('<conversation_history>\n\n</conversation_history>\n\n');
        const historyBudget = maxStdinBytes - utf8Bytes(stdinCurrent) - wrapperBytes;
        let recentBytes = 0;
        let splitIdx = lines.length;
        if (historyBudget > 0) {
            for (let i = lines.length - 1; i >= 0; i--) {
                const lineBytes = utf8Bytes(lines[i]);
                const sepBytes = recentBytes > 0 ? 2 : 0;
                if (recentBytes + sepBytes + lineBytes <= historyBudget) {
                    recentBytes += sepBytes + lineBytes;
                    splitIdx = i;
                } else {
                    break;
                }
            }
        }
        earlierLines = lines.slice(0, splitIdx);
        recentLines = lines.slice(splitIdx);
    }

    const buildPrompt = (recent) => (recent.length
        ? `<conversation_history>\n${recent.join('\n\n')}\n</conversation_history>\n\n${stdinCurrent}`
        : stdinCurrent);

    const buildSections = (sys, earlier, curOver) => {
        const out = [];
        if (sys && sys.trim()) out.push({ heading: 'System_Instructions', content: sys });
        if (earlier.length) out.push({ heading: 'Earlier_Conversation_History', content: earlier.join('\n\n') });
        if (curOver && curOver.trim()) out.push({ heading: 'Current_Turn_Context', content: curOver });
        return out;
    };

    const sampleName = `${CHAT_AGENT_NAME}-000000-0000000000000-0000`;
    const totalSize = (sys, earlier, recent, curOver) => {
        const sections = buildSections(sys, earlier, curOver);
        const agentMd = buildChatAgentMd({ name: sampleName, sections });
        return utf8Bytes(agentMd) + utf8Bytes(buildPrompt(recent));
    };

    let droppedHistoryTurns = 0;
    while (earlierLines.length > 0 && totalSize(sysText, earlierLines, recentLines, currentOverflow) > maxTotalBytes) {
        earlierLines.shift();
        droppedHistoryTurns++;
    }
    while (recentLines.length > 0 && totalSize(sysText, earlierLines, recentLines, currentOverflow) > maxTotalBytes) {
        recentLines.shift();
        droppedHistoryTurns++;
    }
    while (currentOverflow && totalSize(sysText, earlierLines, recentLines, currentOverflow) > maxTotalBytes) {
        const excess = totalSize(sysText, earlierLines, recentLines, currentOverflow) - maxTotalBytes;
        const target = Math.max(0, utf8Bytes(currentOverflow) - excess - 32);
        currentOverflow = target > 0 ? splitUtf8Tail(currentOverflow, target).tail : '';
    }
    while (sysText && totalSize(sysText, earlierLines, recentLines, currentOverflow) > maxTotalBytes) {
        const excess = totalSize(sysText, earlierLines, recentLines, currentOverflow) - maxTotalBytes;
        const target = Math.max(0, utf8Bytes(sysText) - excess - 32);
        sysText = target > 0 ? sliceUtf8Head(sysText, target) : '';
    }

    const prompt = buildPrompt(recentLines);
    const agentSections = buildSections(sysText, earlierLines, currentOverflow);
    return {
        prompt,
        agentSections,
        spilledToAgent: agentSections.length > 0,
        droppedHistoryTurns,
    };
}

