# hub-bot-runner

Single-bot Docker container runtime for Hub v0.5+.

## What this is

Every Telegram bot in Hub runs in its **own** isolated container, with strict
CPU/memory limits and no access to the Hub host filesystem. This package
is the runtime that lives inside that container.

The orchestrator (`botctl`, in the main Hub backend) builds this image once
and spawns one container per registered bot.

## ABI for user code

User code lives at `/app/user/bot.js` and **must** export a default `setup`
function:

```js
export default async function setup(bot, ctx) {
  ctx.on('message', async (msg) => {
    if (msg.text === '/start') {
      await bot.sendMessage(msg.chat.id, 'Hello!');
    }
  });

  ctx.on('callback_query', async (q) => {
    await bot.answerCallbackQuery(q.id, { text: 'Got it' });
  });
}
```

### `bot` API

| Method | Purpose |
|--------|---------|
| `bot.sendMessage(chat_id, text, extra?)` | Send a text message |
| `bot.sendPhoto(chat_id, photo, extra?)`  | Send a photo |
| `bot.editMessageText(params)`            | Edit an existing message |
| `bot.answerCallbackQuery(id, extra?)`    | Acknowledge an inline-button press |
| `bot.deleteMessage(chat_id, message_id)` | Delete a message |
| `bot.getMe()`                            | Get bot account info |
| `bot.call(method, params)`               | Raw access to **any** Telegram Bot API method |

### `ctx` API

| Member | Purpose |
|--------|---------|
| `ctx.on(event, fn)` | Register a handler. Events: `message`, `callback_query`, `inline_query`, `any` |
| `ctx.log(...args)`  | Log to container stdout (Docker captures it) |
| `ctx.env`           | `process.env` with `BOT_TOKEN` redacted |
| `ctx.me()`          | Bot's own user info (returns the cached `getMe()` result) |

## Environment

| Var          | Required | Description                              |
|--------------|----------|------------------------------------------|
| `BOT_TOKEN`  | yes      | Telegram bot token from @BotFather       |

## Resource limits

Limits are set by the orchestrator at `docker run` time, NOT in the image:

```bash
docker run --rm \
  --name bot-<username> \
  --memory=256m \
  --cpus=0.5 \
  --pids-limit=128 \
  --cap-drop=ALL \
  --read-only \
  --tmpfs /tmp \
  -e BOT_TOKEN=$TOKEN \
  -v /var/lib/hub/bots/<username>:/app/user:ro \
  hub-bot-runner:latest
```

Defaults from the `bots` table:
- `cpu_limit` = 0.50 (half a core)
- `mem_limit_mb` = 256

## Lifecycle

1. Container starts, runner reads `BOT_TOKEN` (exits with code 1 if missing).
2. Calls Telegram `getMe` to authenticate (exits code 2 on failure).
3. Loads `/app/user/bot.js` if present, calls `setup(bot, ctx)`.
   - User errors during setup are logged but don't crash the container
     (otherwise Docker restart-loops forever).
4. Long-polls `getUpdates` (timeout=30s) and dispatches updates to handlers.
5. On SIGTERM/SIGINT: aborts in-flight requests, exits cleanly within ~1s.
   Hard kill at 10s if anything stalls.

## Exit codes

| Code | Meaning |
|------|---------|
| 0    | Graceful shutdown via SIGTERM/SIGINT |
| 1    | `BOT_TOKEN` missing/malformed, OR forced exit after 10s shutdown timeout |
| 2    | Telegram `getMe` auth failed |

## Image size

~190 MB (`node:20-alpine` base + a single `runner.js` file, zero npm deps).

## Smoke tests (manual)

```bash
# 1. No token — expect exit 1, "FATAL: BOT_TOKEN missing"
docker run --rm hub-bot-runner:latest

# 2. Malformed token — expect exit 1, same fatal
docker run --rm -e BOT_TOKEN=garbage hub-bot-runner:latest

# 3. Well-formed but invalid token — expect exit 2, "bot auth failed: Unauthorized"
docker run --rm -e BOT_TOKEN=000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA hub-bot-runner:latest
```

(Tests 1 and 2 should complete in <1s. Test 3 takes ~1–2s to fail at
Telegram's auth endpoint.)
