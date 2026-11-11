import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildChatAgentMd, buildAgyEnv, agyBilling, agentLoadState, isolationSupport } from '../server/subscriptions-reference/gemini/agy.js';
import { foldConversationForAgy } from '../server/subscriptions-reference/gemini/prompt.js';
import { resolveGeminiModel } from '../server/subscriptions-reference/gemini/models.js';
import { isolatedAgyStatus } from '../server/isolated-antigravity.js';

test('upstream agent excludes default components and all inherited customizations', () => {
    const text = buildChatAgentMd();
    for (const flag of ['inheritCustomizations: false', 'inheritMcp: false', 'excludeDefaultComponents: true', 'tools: []', 'subagent: false']) assert.ok(text.includes(flag));
});
test('spilled prompts cannot create new agent sections through markdown headings', () => {
    assert.match(buildChatAgentMd({ sections: [{ heading: 'System', content: '# Character\nKeep my voice.' }] }), /# System\n## Character/);
});
test('short request exactly reuses upstream transcript structure', () => {
    const folded = foldConversationForAgy([{ role: 'system', content: 'Stay in character.' }, { role: 'user', content: 'Hello.' }]);
    assert.match(folded.prompt, /Stay in character/);
    assert.match(folded.prompt, /Hello/);
    assert.equal(folded.spilledToAgent, false);
});
test('long requests spill system and earlier context while retaining the newest turn', () => {
    const messages = [{ role: 'system', content: 'CHARACTER '.repeat(100) }, { role: 'user', content: 'Earlier '.repeat(100) }, { role: 'assistant', content: 'A response.' }, { role: 'user', content: 'CURRENT_TURN' }];
    const folded = foldConversationForAgy(messages, { maxStdinBytes: 400, maxTotalBytes: 10000 });
    assert.ok(Buffer.byteLength(folded.prompt) <= 400);
    assert.match(folded.prompt, /CURRENT_TURN/);
    assert.ok(folded.agentSections.some(s => s.content.includes('CHARACTER')));
    assert.equal(folded.droppedHistoryTurns, 0);
});
test('upstream effort resolution avoids conflicting suffix and effort flags', () => {
    const result = resolveGeminiModel('google/gemini-3.8-flash-high', 'medium', { source: 'agy', models: [{ id: 'gemini-3.8-flash-medium' }] });
    assert.equal(result.agyModel, 'gemini-3.8-flash-medium');
    assert.equal(result.agyEffort, undefined);
});
test('unsupported live effort variants fail without a model substitution', () => {
    assert.throws(() => resolveGeminiModel('gemini-3.8-flash-high', 'medium', { source: 'agy', models: [{ id: 'gemini-3.8-flash-low' }] }), /has no/);
});
test('subscription environment scrubs keys and gateway billing while retaining launcher paths', () => {
    const result = buildAgyEnv({ base: { HOME: '/fixture', PATH: '/bin', GEMINI_API_KEY: 'fixture', GOOGLE_GEMINI_BASE_URL: 'http://fixture', AGY_LLM_GATEWAY_URL: 'fixture', OPENAI_API_KEY: 'fixture', HTTPS_PROXY: 'http://proxy' } });
    assert.equal(result.GEMINI_API_KEY, undefined);
    assert.equal(result.GOOGLE_GEMINI_BASE_URL, undefined);
    assert.equal(result.AGY_LLM_GATEWAY_URL, undefined);
    assert.equal(result.OPENAI_API_KEY, undefined);
    assert.equal(result.HOME, '/fixture');
    assert.equal(result.HTTPS_PROXY, 'http://proxy');
});
test('API-billing configurations are refused on the subscription route', () => {
    assert.equal(agyBilling({ modelProvider: 'gemini' }, {}).subscriptionBlocked, true);
    assert.equal(agyBilling({ env: { GOOGLE_GEMINI_BASE_URL: 'http://fixture' } }, {}).subscriptionBlocked, true);
    assert.equal(agyBilling({}, {}).subscriptionBlocked, false);
});
test('upstream version and private-log fallback checks retain their behavior', () => {
    assert.equal(isolationSupport('1.5.3').ok, true);
    assert.equal(isolationSupport('1.2.10').ok, false);
    assert.equal(agentLoadState('Starting new conversation (agent=true)'), 'loaded');
    assert.equal(agentLoadState('Starting new conversation (agent=false)'), 'fallback');
});
test('CLI status distinguishes readiness from authenticated sign-in', async () => {
    const status = await isolatedAgyStatus();
    assert.equal(status.loggedIn, null);
    assert.equal(status.authState, 'unknown');
});
test('upstream provenance and license are retained', () => {
    assert.match(readFileSync(new URL('../server/subscriptions-reference/LICENSE', import.meta.url), 'utf8'), /GNU AFFERO GENERAL PUBLIC LICENSE/);
});
