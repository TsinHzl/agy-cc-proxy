# API Endpoints

| Endpoint          | Method | Description                                                           |
| ----------------- | ------ | --------------------------------------------------------------------- |
| `/health`         | GET    | Health check                                                          |
| `/account-limits` | GET    | Account status and quota limits (add `?format=table` for ASCII table) |
| `/v1/messages`             | POST   | Anthropic Messages API                                                |
| `/v1/chat/completions`     | POST   | OpenAI Chat Completions API (streaming + non-streaming, tool calls)   |
| `/v1/models`               | GET    | List available models                                                 |
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

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```
