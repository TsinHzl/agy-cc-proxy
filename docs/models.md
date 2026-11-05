# Available Models

## Claude Models

| Model ID                     | Description                              |
| ---------------------------- | ---------------------------------------- |
| `claude-sonnet-4-6-thinking` | Claude Sonnet 4.6 with extended thinking |
| `claude-opus-4-6-thinking`   | Claude Opus 4.6 with extended thinking   |
| `claude-sonnet-4-6`          | Claude Sonnet 4.6 without thinking       |

## Gemini Models

| Model ID            | Description                     |
| ------------------- | ------------------------------- |
| `gemini-3-flash`    | Gemini 3 Flash with thinking    |
| `gemini-3.1-pro-low`  | Gemini 3.1 Pro Low with thinking  |
| `gemini-3.1-pro-high` | Gemini 3.1 Pro High with thinking |

Gemini models include full thinking support with `thoughtSignature` handling for multi-turn conversations.

## Auto (Priority Chain)

`auto` is a virtual alias, not a Cloud Code model. It resolves to the priority chain in
`autoModel` and switches models **only on quota exhaustion**.

| Model ID | Source                              | Notes                                              |
| -------- | ----------------------------------- | -------------------------------------------------- |
| `auto`   | `config.autoModel`                  | Requires `enabled: true` and at least one entry    |

```bash
# Claude first, Gemini as the quota fallback
curl http://localhost:8080/v1/messages \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"auto","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

`auto` never appears in the model-validation cache and is rejected as a chain entry.
Usage logs record the model that actually served the request, not `auto`.
