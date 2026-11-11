# Capability request: account context for adapter metadata calls

A registered LLM adapter needs the asking account's library/context when listing models, just as `llm.request` receives it for generation. `listModels(profile, signal)` currently receives neither the db nor a corresponding request hook.

OAuth Subscriptions selects different direct and subprocess model catalogs from an account setting. Its generation hook has the db, but a model-picker call immediately after restart does not. Defaulting then can contact the wrong backend.

The extension now binds its account/profile mapping through its authenticated `/model-context` route during client initialization; status refresh also binds it. A cold API-only model call fails with an actionable message instead of using a guessed mode. API-only callers can initialize this route first. This keeps all implementation in the extension.

A generic metadata-call context or hook would eliminate that bootstrap dependency. Another unrelated provider could use it for an account's region, enterprise gateway, or credential-store selection when listing models. With no extensions installed the extra context has no effect. No change naming any particular extension or its settings is requested. This document is local; no remote issue was opened.
