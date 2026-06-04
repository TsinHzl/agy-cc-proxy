# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Antigravity Claude Proxy is a Node.js proxy server that translates Anthropic Messages API format requests into Google Generative AI format, backing them with Google Generative AI / Gemini models and forwarding them via Antigravity Cloud Code services. It supports streaming responses, thinking signatures, caching, and multiple Google accounts rotation.

## Commands

### Running the Server
```bash
# Install dependencies (automatically runs tailwind CSS prepare hook)
npm install

# Start server on default port (8080)
npm start

# Start with specific options (arguments can be combined)
npm start -- --strategy=sticky      # sticky (cache-optimized) | round-robin | hybrid (default)
npm start -- --fallback            # Enable model fallback (quota exhausted failover)
npm start -- --dev-mode            # Run in developer mode (debug logging + health endpoints)

# Development auto-reload
npm run dev                         # Watch backend server files only
npm run dev:full                    # Watch both frontend assets (Tailwind CSS) and server files
```

### Account Management
```bash
npm run accounts                    # Interactive CLI account manager
npm run accounts:add                # Add Google Account via OAuth
npm run accounts:add -- --no-browser # Headless OAuth setup
npm run accounts:list               # List configured accounts
npm run accounts:verify             # Verify tokens validity
```

### Testing
```bash
# Run all integration tests (requires server running on port 8080)
npm test

# Run individual test suites
npm run test:signatures             # Thinking signatures recovery & validation
npm run test:multiturn              # Multi-turn conversational flow with tools
npm run test:streaming              # SSE events streaming validation
npm run test:interleaved            # Interleaved text/thinking block parsing
npm run test:images                 # Image content conversion and forwarding
npm run test:caching                # Prompt caching behavior
npm run test:crossmodel             # Mid-conversation Claude <-> Gemini signature translation
npm run test:oauth                  # Headless OAuth verification
npm run test:cache-control          # Cache control headers removal validation

# Run strategy unit tests (independent of running server)
node tests/test-strategies.cjs
```

## Architecture & Code Organization

### Core Modules
* **`src/server.js`**: Express server handling API requests (`/v1/messages`, `/v1/models`, `/health`, `/account-limits`) and hosting the WebUI.
* **`src/cloudcode/`**: Antigravity API wrapper. Prepares requests, handles streaming/non-streaming response generation, parses rate limits, and coordinates fallback logic.
* **`src/account-manager/`**: Coordinates the account pool. Implements strategies (`sticky`, `round-robin`, `hybrid`), manages credentials state in `accounts.json`, tracks rate limits, and uses trackers (`health`, `token-bucket`, `quota`) to select the optimal account.
* **`src/format/`**: Request and response converter pipeline. Maps parameters, sanitizes schemas, and processes thinking blocks.
* **`src/webui/`**: Backend routing for settings management, log streaming, and stats tracking.
* **`src/auth/`**: Google OAuth (PKCE), database extraction utility, and SQLite access layers.

### Critical Engineering Guidelines

1. **Cache Control Striping**: Gemini API rejects requests containing `cache_control` keys. All `cache_control` attributes must be stripped from content blocks at the very beginning of the pipeline via `cleanCacheControl(messages)` in `src/format/request-converter.js`.
2. **Cross-Model Thinking Signatures**: Claude and Gemini use incompatible thinking formats.
   - Claude expects a `signature` on thinking blocks.
   - Gemini expects a `thoughtSignature` on functionCall blocks.
   - Handled via `src/format/thinking-utils.js` and `signature-cache.js`. Interrupted tool loops must be safely closed via `closeToolLoopForThinking()`.
3. **Environment and Deployment**:
   - `CLAUDE_CONFIG_PATH` should be utilized to resolve the real user's CLI configuration path (especially when run under root/systemd service contexts).
   - `better-sqlite3` uses a native module rebuilder (`src/utils/native-module-helper.js`) to automatically handle Node.js version mismatches at runtime.
4. **OAuth Ports**: For OS compatibility, the OAuth callback listener tries fallback ports (in range 51121-51126) if the main port is blocked by Hyper-V/Docker on Windows.
