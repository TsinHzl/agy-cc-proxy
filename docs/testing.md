# Testing

Run the test suite (requires server running):

```bash
# Start server in one terminal
npm start

# Run tests in another terminal
npm test
```

Individual tests:

```bash
npm run test:signatures    # Thinking signatures
npm run test:multiturn     # Multi-turn with tools
npm run test:streaming     # Streaming SSE events
npm run test:interleaved   # Interleaved thinking
npm run test:images        # Image processing
npm run test:caching       # Prompt caching
npm run test:strategies    # Account selection strategies
npm run test:cache-control # Cache control field stripping
npm run test:openai        # OpenAI compat endpoint (live server)
npm run test:openai-converter # OpenAI converter unit tests (no server)
npm run test:auto          # Auto model routing (self-starts its own server)
npm run test:auto -- --unit-only  # Auto model routing, no server required
```

### Auto Model Routing Suite

`test:auto` is **not** part of `tests/run-all.cjs`: `run-all.cjs` assumes a server on
`:8080`, while this suite starts its own child server on a free ephemeral port
(override with `AUTO_TEST_PORT`) inside a temporary `HOME`, so it never touches your
real accounts, config, or the `:8080` port.

Phases: pure functions → handler source assertions → wrapper with injected deps →
`/v1/models` against a mocked upstream (undici `MockAgent`) → HTTP integration
(WebUI config routes, preset exclusion, disabled-chain errors).

The Claude → Gemini cross-vendor switch case requires **real upstream quota exhaustion**
and is therefore opt-in:

```bash
AUTO_TEST_LIVE=1 npm run test:auto
```

When the live case cannot be exercised (no self-contained credentials, upstream 429, or
no switch observed) it is reported as `SKIP` and counted in the skipped total — it never
reports a pass it did not verify.
