# API Endpoints

| Endpoint          | Method | Description                                                           |
| ----------------- | ------ | --------------------------------------------------------------------- |
| `/health`         | GET    | Health check                                                          |
| `/account-limits` | GET    | Account status and quota limits (add `?format=table` for ASCII table) |
| `/v1/messages`             | POST   | Anthropic Messages API                                                |
| `/v1/chat/completions`     | POST   | OpenAI Chat Completions API (streaming + non-streaming, tool calls)   |
| `/v1/models`               | GET    | List available models                                                 |
| `/api/models/auto`         | GET    | Read the `auto` priority chain (raw config + resolved chain)          |
| `/api/models/auto`         | POST   | Replace the `auto` priority chain (strict validation, 400 on reject)  |
| `/refresh-token`  | POST   | Force token refresh                                                   |

## OpenAI Compatibility (`/v1/chat/completions`)

The proxy accepts OpenAI Chat Completions requests (Bearer API key) and runs them
through the same Cloud Code pipeline as `/v1/messages`.

Supported: `messages` (system/developer/user/assistant/tool), `tools` + `tool_choice`,
image parts (`data:` URLs and http(s) URLs), `stream`, `temperature`, `top_p`,
`max_tokens`, `stop`.

Not supported (400): `n > 1`, `logprobs`, `logit_bias`.

Streaming emits `chat.completion.chunk` SSE events terminated by `data: [DONE]`;
thinking blocks are dropped and tool calls are aggregated by `index`. Errors use
the OpenAI envelope (`{error: {message, type, code}}`); 429 keeps status 429.

## Auto Model Routing (`/api/models/auto`)

`GET` returns the stored chain plus the resolved execution order:

```json
{
  "status": "ok",
  "autoModel": { "enabled": true, "models": [{ "model": "claude-opus-4-6-thinking", "priority": 1 }] },
  "chain": ["claude-opus-4-6-thinking"]
}
```

`POST` replaces the whole chain. Invalid input (non-boolean `enabled`, empty chain while
enabled, non-integer or `< 1` priority, duplicate or self-referencing model, more than
10 entries) returns `400` and leaves the stored config untouched.

When enabled, `GET /v1/models` prepends a synthetic `auto` entry
(`owned_by: "antigravity-proxy"`, `description: "Auto routing: a → b"`).
See [Auto Model Routing](configuration.md#auto-model-routing) for switching semantics.

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```
