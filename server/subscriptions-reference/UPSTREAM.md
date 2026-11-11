# Source provenance

Adapted from LukaTheHero/SillyTavern-Subscriptions, commit `46fe9ceaae31e6f4274d577cf222901f5b92f099`, under AGPL-3.0. See LICENSE.

The driver uses Sigma's existing executable resolver for the Android transactional launcher. Runtime data uses temporary storage. Sigma retains scoped SQLite/protobuf cleanup and structured result errors, and requires a terminal SUCCESS result. The prompt partitioner is extracted verbatim from lib/gemini/chat.js. Models, messages, completion writer, stops, usage helpers, platform and cancellation modules retain upstream implementations. The Sigma bridge converts completion events to its async stream interface. Existing Direct CloudCode remains available pending migration review.
