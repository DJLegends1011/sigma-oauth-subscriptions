// OAuth Subscriptions client half: live CLI status + roleplay controls in Settings > Extensions.

export default {
    init(ctx) {
        const esc = s => ctx.CoreAPI.escapeHtml(String(s ?? ''));

        ctx.ui.addSettingsSection(el => {
            let statusData = null;
            let loadingStatus = false;

            const formatQuota = quota => {
                if (!quota?.windows?.length) return '';
                const parts = quota.windows.map(w => {
                    const pct = typeof w.utilization === 'number' ? `${Math.round(w.utilization * 100)}%` : '?';
                    return `${esc(w.type)}: ${pct}`;
                });
                return ` · Quota: ${parts.join(', ')}`;
            };

            const formatAgyPools = pools => {
                if (!Array.isArray(pools) || !pools.length) return '';
                const parts = pools.map(p => `${esc(p.name)}: ${esc(p.usedPct)}% used (${esc(p.remainingPct)}% left)`);
                return ` · ${parts.join(' | ')}`;
            };

            const renderStatusHtml = () => {
                if (loadingStatus && !statusData) {
                    return '<div class="settings-hint">Checking local Claude Code, Codex &amp; Antigravity CLI installations…</div>';
                }
                if (!statusData) {
                    return '<div class="settings-hint">Click "Refresh CLI Status" to inspect local logins and quota.</div>';
                }
                const c = statusData.claude || {};
                const x = statusData.codex || {};
                const a = statusData.antigravity || {};

                const claudeBadge = c.installed
                    ? (c.loggedIn
                        ? `✅ Installed (v${esc(c.version || '?')}) · Logged in (${esc(c.subscriptionType || 'oauth')}${c.rateLimitTier ? ` / ${esc(c.rateLimitTier)}` : ''})${formatQuota(c.quota)}`
                        : `⚠️ Installed (v${esc(c.version || '?')}) · Not logged in (run <code>claude auth login</code>)`)
                    : '❌ Not found on PATH';

                const codexBadge = x.installed
                    ? (x.loggedIn
                        ? `✅ Installed (v${esc(x.version || '?')}) · Logged in (${esc(x.authMode || 'chatgpt')}${x.planType ? ` / ${esc(x.planType)}` : ''})`
                        : `⚠️ Installed (v${esc(x.version || '?')}) · Not logged in (run <code>codex login</code>)`)
                    : '❌ Not found on PATH';

                const agyBadge = a.installed
                    ? (a.loggedIn
                        ? `✅ Installed (v${esc(a.version || '?')}) · Logged in (${esc(a.tierName || 'Antigravity')}${a.email ? ` · ${esc(a.email)}` : ''})${formatAgyPools(a.pools)}`
                        : `⚠️ Installed (v${esc(a.version || '?')}) · Not logged in (run <code>agy</code>)`)
                    : '❌ Not found on PATH';

                return `
                    <div class="settings-hint" style="margin-bottom:8px;">
                        <div><strong>Claude Code CLI:</strong> ${claudeBadge}</div>
                        <div style="margin-top:4px;"><strong>Codex CLI:</strong> ${codexBadge}</div>
                        <div style="margin-top:4px;"><strong>Antigravity CLI:</strong> ${agyBadge}</div>
                    </div>`;
            };

            const draw = () => {
                const claudeUseResume = ctx.settings.get('claudeUseResume') !== false;
                const claudeIdentityMode = ctx.settings.get('claudeIdentityMode') === true;
                const claudeFastMode = ctx.settings.get('claudeFastMode') === true;
                const codexReasoningSummary = String(ctx.settings.get('codexReasoningSummary') || 'auto');
                const codexVerbosity = String(ctx.settings.get('codexVerbosity') || 'medium');
                const antigravityMode = String(ctx.settings.get('antigravityMode') || 'direct');

                el.innerHTML = `
                    <div class="settings-row">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
                            <strong>Local CLI Subscription Status</strong>
                            <button type="button" class="glass-btn" data-oauth-refresh style="padding:4px 10px;font-size:0.85em;">${loadingStatus ? 'Checking…' : 'Refresh CLI Status'}</button>
                        </div>
                        ${renderStatusHtml()}
                    </div>
                    <div class="settings-row">
                        <label><input type="checkbox" class="cl-switch-input" data-oauth-bool="claudeUseResume"${claudeUseResume ? ' checked' : ''}><span class="cl-switch" aria-hidden="true"></span> Claude: Multi-turn JSONL session replay (<code>--resume</code>)</label>
                        <span class="settings-hint">Replays prior chat turns as a native Claude Code JSONL transcript for real user/assistant role separation and prompt caching.</span>
                    </div>
                    <div class="settings-row">
                        <label><input type="checkbox" class="cl-switch-input" data-oauth-bool="claudeIdentityMode"${claudeIdentityMode ? ' checked' : ''}><span class="cl-switch" aria-hidden="true"></span> Claude: Send account identity (disable account isolation)</label>
                        <span class="settings-hint">Keep off for privacy: when off, Claude Code runs in an isolated config directory with only the OAuth bearer token so your email/org profile is never added to prompts.</span>
                    </div>
                    <div class="settings-row">
                        <label><input type="checkbox" class="cl-switch-input" data-oauth-bool="claudeFastMode"${claudeFastMode ? ' checked' : ''}><span class="cl-switch" aria-hidden="true"></span> Claude: Enable Fast Mode (<code>CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK=1</code>)</label>
                        <span class="settings-hint">Opt into Fast Mode output on supported plans (may draw Extra Usage credits).</span>
                    </div>
                    <div class="settings-row">
                        <label for="oauth-codex-summary">Codex: Reasoning summary</label>
                        <select id="oauth-codex-summary" class="glass-input" data-oauth-set="codexReasoningSummary">
                            <option value="auto"${codexReasoningSummary === 'auto' ? ' selected' : ''}>Auto</option>
                            <option value="concise"${codexReasoningSummary === 'concise' ? ' selected' : ''}>Concise</option>
                            <option value="detailed"${codexReasoningSummary === 'detailed' ? ' selected' : ''}>Detailed</option>
                            <option value="none"${codexReasoningSummary === 'none' ? ' selected' : ''}>None (hide reasoning summaries)</option>
                        </select>
                        <span class="settings-hint">Controls the reasoning summary streamed into Project Σ's Thinking fold by <code>codex app-server</code>.</span>
                    </div>
                    <div class="settings-row">
                        <label for="oauth-codex-verbosity">Codex: Reply verbosity</label>
                        <select id="oauth-codex-verbosity" class="glass-input" data-oauth-set="codexVerbosity">
                            <option value="low"${codexVerbosity === 'low' ? ' selected' : ''}>Low (terse)</option>
                            <option value="medium"${codexVerbosity === 'medium' ? ' selected' : ''}>Medium (balanced for roleplay — default)</option>
                            <option value="high"${codexVerbosity === 'high' ? ' selected' : ''}>High (expressive / descriptive)</option>
                        </select>
                        <span class="settings-hint">Sets <code>model_verbosity</code> on ephemeral Codex roleplay threads (stock Codex defaults to <code>low</code> for coding).</span>
                    </div>
                    <div class="settings-row">
                        <label for="oauth-agy-mode">Antigravity: Execution mode</label>
                        <select id="oauth-agy-mode" class="glass-input" data-oauth-set="antigravityMode">
                            <option value="direct"${antigravityMode !== 'cli' ? ' selected' : ''}>Direct CloudCode CLI API (Recommended — pure roleplay, zero 12k coding prompt overhead)</option>
                            <option value="cli"${antigravityMode === 'cli' ? ' selected' : ''}>Subprocess CLI (agy --output-format stream-json -p=...)</option>
                        </select>
                        <span class="settings-hint">Direct mode uses your <code>~/.gemini/antigravity-cli/antigravity-oauth-token</code> with the <code>antigravity</code> CLI User-Agent, saving ~12,300 prompt tokens per turn.</span>
                    </div>`;

                for (const input of el.querySelectorAll('[data-oauth-set]')) {
                    input.addEventListener('change', () => {
                        ctx.settings.set(input.dataset.oauthSet, input.value.trim());
                    });
                }
                for (const input of el.querySelectorAll('[data-oauth-bool]')) {
                    input.addEventListener('change', () => {
                        ctx.settings.set(input.dataset.oauthBool, Boolean(input.checked));
                    });
                }
                const refreshBtn = el.querySelector('[data-oauth-refresh]');
                if (refreshBtn) {
                    refreshBtn.addEventListener('click', () => {
                        fetchStatus();
                    });
                }
            };

            const fetchStatus = async () => {
                if (loadingStatus) return;
                loadingStatus = true;
                draw();
                try {
                    statusData = await ctx.server.call('/status', 'GET');
                } catch {
                    statusData = null;
                } finally {
                    loadingStatus = false;
                    draw();
                }
            };

            draw();
            fetchStatus();
        });
    },
};
