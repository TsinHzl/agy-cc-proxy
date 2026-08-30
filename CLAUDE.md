# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Antigravity Claude Proxy (`antigravity-claude-proxy`, v2.7.8) is a Node.js (ESM, ≥18) proxy server that exposes an **Anthropic Messages API** surface and translates each request into Google Cloud Code's internal `v1internal:streamGenerateContent` endpoint, backed by Gemini / Claude models served through Antigravity Cloud Code services. It supports streaming + non-streaming responses, interleaved thinking blocks with cross-model signature translation, prompt caching stripping, multi-account rotation with pluggable selection strategies, and a built-in WebUI dashboard.

Request pipeline is **stateless** — no per-request state survives outside the request lifecycle except durable account/quota/usage persistence on disk.

## Commands

### Running the Server
```bash
npm install            # installs deps + runs tailwind build:css prepare hook
npm start              # default port (DEFAULT_PORT from config, fallback 12345)
npm start -- --strategy=sticky      # sticky | round-robin | hybrid (default hybrid)
npm start -- --fallback             # enable model fallback (quota-exhausted failover)
npm start -- --dev-mode             # debug logging + health endpoints
npm run dev                         # node --watch backend only
npm run dev:full                    # watch tailwind + backend concurrently
```

### Account Management (CLI)
```bash
npm run accounts                    # interactive manager
npm run accounts:add                # OAuth add (PKCE)
npm run accounts:add -- --no-browser # headless OAuth
npm run accounts:list               # list configured accounts
npm run accounts:verify             # verify token validity
```

### Deployment (PM2 / shell scripts)
```bash
./start.sh                          # shell wrapper to launch the server
./stop.sh                           # shell wrapper to stop the server
pm2 start ecosystem.config.cjs      # PM2: app name agy-cc-proxy, args --strategy=hybrid, env PORT=12345
pm2 logs agy-cc-proxy               # PM2 log tail
```
`bin/cli.js` is the published CLI entry (binaries `antigravity-claude-proxy` + `acc`).

### Testing (custom CJS runners — most need a live server on :8080)
```bash
npm test                  # tests/run-all.cjs — full integration suite (needs running server)
npm run test:signatures   # thinking signatures recovery & validation
npm run test:multiturn    # multi-turn conversational flow with tools
npm run test:streaming    # SSE events streaming validation
npm run test:interleaved  # interleaved text/thinking block parsing
npm run test:images       # image content conversion and forwarding
npm run test:caching      # prompt caching behavior
npm run test:crossmodel   # mid-conversation Claude <-> Gemini signature translation
npm run test:oauth        # headless OAuth verification
npm run test:emptyretry   # empty-response retry path
npm run test:sanitizer    # schema sanitizer (independent of server)
npm run test:strategies   # strategy unit tests (independent of server)
npm run test:cache-control# cache_control header removal validation
npm run test:compact      # /compact request detection & handling
```
`tests/run-all.cjs` orchestrates the full suite (17 suites incl. `test-403-account-rotation`, `test-403-integration`, `test-streaming-whitespace`, `test-version-detection`). `tests/stress-test-*.cjs` are standalone load scripts.

## Architecture & Code Organization

### Core Modules
* **`src/server.js`** (~1056 lines): Express entry. API routing (`/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`, `/health`, `/account-limits`, `/refresh-token`, `/test/clear-signature-cache`), API-key + WebUI auth middleware, access logging, error classification (`parseError` → errorType/statusCode/retry-after), streaming buffering strategy (pull first event before flushing headers so upstream 4xx/5xx becomes a JSON error instead of a broken SSE stream), usage logging.
* **`src/index.js`**: Process bootstrap — loads config, starts Express listener on `DEFAULT_PORT`.
* **`src/cloudcode/`**: Antigravity API wrapper. Thin `index.js` re-exports public API (`sendMessage`, `sendMessageStream`, `listModels`, `fetchAvailableModels`, `getModelQuotas`, `getSubscriptionTier`, `isValidModel`, `resolveModel`).
  * `message-handler.js` / `streaming-handler.js` — non-streaming / streaming request execution with multi-account failover, retry, endpoint fallback (`daily` → `prod`).
  * `request-builder.js` — builds wrapped `v1internal` payload (injects `ANTIGRAVITY_SYSTEM_INSTRUCTION` with `[ignore]` tags, `requestType: 'agent'`, `requestId`, `sessionId`, `project`). **Sets `anthropic-beta: interleaved-thinking-2025-05-14` header only for Claude thinking models.**
  * `session-manager.js` — derives stable `sessionId` from first user message for cache continuity.
  * `sse-parser.js` / `sse-streamer.js` — Google SSE → Anthropic SSE event translation.
  * `model-api.js` — model listing, quota, subscription tier, model validation + auto-mapping (`resolveModel`).
  * `rate-limit-parser.js` / `rate-limit-state.js` — quota reset parsing, smart backoff by error type, ban/forbidden/validation detection.
* **`src/account-manager/`** (~2787 lines total): Account pool coordinator. `index.js` (`AccountManager` class), `storage.js` / `credentials.js` (token + project caches), `rate-limits.js` (cooldown / consecutive-failure / invalid tracking), `onboarding.js`. Strategies under `strategies/`: `sticky` (cache-optimized), `round-robin`, `hybrid` (smart distribution) + `base-strategy.js`. Trackers under `strategies/trackers/`: `health-tracker`, `token-bucket-tracker`, `quota-tracker`.
* **`src/format/`**: Request/response converter pipeline.
  * `request-converter.js` — `convertAnthropicToGoogle`, **`cleanCacheControl`** (strips `cache_control` keys at pipeline start), `isCompactRequest` (multi-signal `/compact` + reactive-compact detection, scoped to current user turn).
  * `response-converter.js`, `content-converter.js` (image/media block handling).
  * `schema-sanitizer.js` (~673 lines) — sanitizes tool/JSON schemas to satisfy Gemini strict proto validation.
  * `thinking-utils.js` (~698 lines) — cross-model thinking block handling: `clampGeminiThinkingBudget`, `hasUnsignedThinkingBlocks`, `filterUnsignedThinkingBlocks`, `restoreThinkingSignatures`, `reorderAssistantContent`, `needsThinkingRecovery`, **`closeToolLoopForThinking`** (safely closes interrupted tool loops).
  * `signature-cache.js` — Gemini `thoughtSignature` cache (TTL `GEMINI_SIGNATURE_CACHE_TTL_MS`, 2h).
* **`src/webui/index.js`** (~1376 lines, 39 `app.<verb>` routes): Web dashboard backend — auth (scrypt-hashed password, `createAuthMiddleware`), account CRUD/refresh/toggle/export/import/reload, config get/set, password set, settings, Claude config + mode + presets (restore), server presets, model config, logs + log stream (SSE), strategy health, OAuth add flow (`/api/auth/url` + `/api/auth/complete` on localhost:51121). Mounts `public/` static assets.
* **`src/auth/`**: `oauth.js` (Google OAuth 2.0 PKCE), `database.js` (SQLite access via `better-sqlite3`), `token-extractor.js` (extract tokens from Antigravity app DB, `forceRefresh`).
* **`src/utils/`**: `logger.js`, `helpers.js` (`formatDuration`, `sleep`, `isNetworkError`, `throttledFetch`), `native-module-helper.js` (rebuilds `better-sqlite3` native binding on Node version mismatch), `claude-config.js` (resolves real user CLI config path via `CLAUDE_CONFIG_PATH`), `version-detector.js` (reads Antigravity `product.json` → `X-Client-Version` + User-Agent), `server-presets.js`, `proxy.js`.
* **`src/modules/`**: `usage-log.js` (per-request detail records, pricing table for credit estimation, 5000-record cap), `usage-stats.js` (aggregate stats + middleware/routes).
* **`src/constants.js`** (~544 lines): All tunables (retry/cooldown/backoff tiers), endpoint fallbacks, headers, `CLIENT_METADATA`, `getModelFamily`, `isThinkingModel`, `MODEL_MAP` (alias), `MODEL_FALLBACK_MAP`, `TEST_MODELS`, `DEFAULT_PRESETS`, `DEFAULT_SERVER_PRESETS`.
* **`src/config.js`**: Loads/merges `config.json` over `DEFAULT_CONFIG`; `generateApiKey`, `verifyApiKey` (timing-safe), `hashPassword`/`verifyPassword` (scrypt), `deepMerge` (prototype-pollution guarded).
* **`src/errors.js`**: Typed error hierarchy (`AntigravityError` base → `RateLimitError`, `AuthError`, `NoAccountsError`, `MaxRetriesError`, `ApiError`, `NativeModuleError`, `EmptyResponseError`, `CapacityExhaustedError`, `AccountForbiddenError`) + `is*` type guards.
* **`src/fallback-config.js`**: `getFallbackModel` — model fallback resolution when `--fallback` enabled.

### Frontend
`public/` — Alpine.js + Tailwind CSS v3 + DaisyUI v4 + Chart.js. Views under `public/views/` (dashboard, accounts, logs, settings, usage-log, models). Built CSS via `npm run build:css` / `watch:css`. Keep Alpine.js reactive model; avoid jQuery patterns.

### Tests
`tests/*.cjs` — CommonJS integration tests requiring a live server on **:8080** (except `test-strategies.cjs` + `test-schema-sanitizer.cjs` which are standalone). `tests/run-all.cjs` orchestrates the full suite. `tests/frontend/` has Playwright-style frontend tests; `tests/helpers/` shared HTTP client + model helpers.

## Critical Engineering Guidelines

1. **Cache Control Striping (hard invariant)**: Gemini strict proto validation rejects unknown fields. All `cache_control` attributes MUST be stripped from content blocks at the very start of the pipeline via `cleanCacheControl()` in `src/format/request-converter.js` — before any Cloud Code API call.
2. **Cross-Model Thinking Signatures**: Claude and Gemini use incompatible thinking formats — Claude expects a `signature` on thinking blocks; Gemini expects a `thoughtSignature` on `functionCall` blocks. Handled in `src/format/thinking-utils.js` + `signature-cache.js`. Interrupted tool loops MUST be safely closed via `closeToolLoopForThinking()`. Cache can be cleared via `POST /test/clear-signature-cache` for cold-cache test scenarios.
3. **sessionId invariant**: `sessionId` MUST be set for cache continuity (derived in `session-manager.js`) — except it must NOT be set for the Gemini model family per request-builder constraints. `model` field in the Cloud Code payload MUST use the post-auto-map name (`requestedModel`, not the raw `modelId`).
4. **Model routing**: New model support MUST go through `constants.js` (`getModelFamily`, `isThinkingModel`, `MODEL_MAP`, `MODEL_FALLBACK_MAP`) — no scattered conditionals. Unknown Claude/Gemini names are auto-mapped by `resolveModel()` in `model-api.js` to the closest available Cloud Code model to avoid `INVALID_ARGUMENT`.
5. **Streaming error handling**: First SSE event is pulled before headers flush so an upstream 429/503 surfaces as a proper JSON error (with `Retry-After` from `parseResetDuration`) rather than a half-sent stream. Mid-stream errors fall back to an SSE `error` event. 429/`RESOURCE_EXHAUSTED`/`QUOTA_EXHAUSTED` responses preserve status 429 so Claude Code backs off and retries on its own.
6. **Compact request detection**: `isCompactRequest()` checks multiple independent signals (system-prompt anchors, `/compact` user text, CC v2.1+ reactive-compact summarization prompt, `x-stainless-helper: compaction` header) scoped to the current user turn — false positives are harmless (thinking disabled for that turn), false negatives reproduce the `summarization produced empty response` bug.
7. **Account selection**: Strategies (`sticky`/`round-robin`/`hybrid`) configured via CLI `--strategy`, `ACCOUNT_STRATEGY` env, or `config.accountSelection.strategy`. Optimistic retry resets all rate limits when every account is limited for a model. Invalid (banned/ToS) accounts fail fast and require WebUI FIX — they never self-recover.
8. **Environment & deployment**:
   - `CLAUDE_CONFIG_PATH` resolves the real user's CLI config path (especially under root/systemd contexts).
   - `better-sqlite3` native binding is auto-rebuilt at runtime by `src/utils/native-module-helper.js` on Node version mismatch.
   - OAuth callback listener tries fallback ports 51122–51126 if the main port (default 51121, `OAUTH_CALLBACK_PORT` env) is blocked by Hyper-V/Docker on Windows.
   - `DEFAULT_PORT` from config (fallback 12345); test suite expects server on **8080**.
   - Account/quota/usage data persists under `~/.config/antigravity-proxy/` (`accounts.json`, `usage-history.json`, `usage-log.json`).
9. **Error handling pattern**: Follow the throw/catch + retry pattern in `streaming-handler.js` / `message-handler.js` — typed errors from `src/errors.js`, smart backoff by error type, progressive capacity/quota backoff tiers, retry dedup window to prevent thundering herd.
10. **Security**: API key auth on `/v1/*` (timing-safe `verifyApiKey`). WebUI behind scrypt-hashed password + `createAuthMiddleware`. `deepMerge` guards against `__proto__`/`constructor`/`prototype` pollution. Rate-limit/account email identifiers are intentionally NOT leaked to the client in error messages.
