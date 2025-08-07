# Slack Digest Bot (“/summarize”)

Summarise the last 24 h of any Slack channel in ≤ 120 words, then list **Action Items** as bullets.  
Fast UX (instant *“📝 Summarising…”*) + heavy LLM work off-loaded to a Vercel **background function**.

---

## ✨ Features
| | |
|---|---|
| **Slash command** | `/summarize` (ephemeral to invoker) |
| **Models** | `MODEL_PROVIDER=openai \| groq` →<br>• OpenAI `gpt-4o-mini` (default)<br>• Groq `llama3-8b-8192` (cheap dev) |
| **Zero timeouts** | `ack()` inside 200 ms ⇒ no Slack *operation_timeout* |
| **Preview-safe** | `x-vercel-protection-bypass` header skips Vercel password wall |
| **Clean channel** | Placeholder + summary visible **only** to the requester |
| **15-min bursts** | Background function (`*.background.ts`) gets 15 min & 1024 MB |

---

## 🗂 Repo layout

api/
├─ slack/
│ ├─ event.ts # slash-command receiver (Bolt)
│ └─ summarize.background.ts # long-running worker (LLM + postEphemeral)
├─ _routes.ts (optional) # debug endpoint lists all API routes


---

## ⚙️ Environment Variables

| Name | Description |
|------|-------------|
| `SLACK_BOT_TOKEN` | **Bot** token (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | Slack app Signing Secret |
| `MODEL_PROVIDER` | `openai` (default) \| `groq` |
| `OPENAI_API_KEY` | Your OpenAI key (if provider = openai) |
| `GROQ_API_KEY` | Your Groq key (if provider = groq) |
| `OPENAI_MODEL` | Override default (`gpt-4o-mini`) |
| `GROQ_MODEL` | Override default (`llama3-8b-8192`) |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | *Protection Bypass for Automation* secret – lets server-to-server calls skip preview password |
| _(set by Vercel)_ `VERCEL_URL` | Hostname of the current deployment |

> **Tip :** generate `VERCEL_AUTOMATION_BYPASS_SECRET` in **Project ▸ Settings ▸ Deployment Protection**.

---

Vercel console → Functions should list

api/slack/summarize.background   • background
api/slack/event                  • edge / serverless

🛠 Slack App setup
Slash Commands
• /summarize → Request URL https://<production-host>/api/slack/event
• Short desc: “Summarise the last 24 h of this channel”.

Scopes
commands, chat:write, channels:history, channels:read, groups:*, im:*, mpim:*

Event Subscriptions – none needed.

Install to workspace → copy Bot Token & Signing Secret to Vercel env.



Key Building Blocks

| Layer                                               | Final Design                                                                                                                                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Slash-command handler** (`/api/slack/event`)      | • `await ack({text:"📝 Summarising…", response_type:"ephemeral"})` in < 200 ms (prevents *operation\_timeout*)<br>• Collects channel history<br>• `fetch()` **background** worker at `/api/slack/summarize.background` |
| **Background function** (`summarize.background.ts`) | • Receives `{channel, user, text}`<br>• Selects provider + model from `MODEL_PROVIDER`, `OPENAI_*` or `GROQ_*` env vars<br>• Calls LLM → summary<br>• `chat.postEphemeral` to the requester with final summary         |
| **Preview protection**                              | Added `x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}` header so background calls skip the password wall.                                                                                              |
| **Routing quirks**                                  | File lives at `api/slack/summarize.background.ts`; public URL is **`/api/slack/summarize.background`** (the “.background” suffix stays).                                                                               |
| **Typescript gotcha**                               | Replaced `choices.at(0)` with `choices[0]` (or set `target:"ES2022"`) to compile under default libs.                                                                                                                   |

Pain Points & Fixes
| Issue                                    | Fix                                                             |
| ---------------------------------------- | --------------------------------------------------------------- |
| **401 Preview auth**                     | Added bypass header.                                            |
| **404 after bypass**                     | Path mismatch – corrected to `/api/slack/summarize.background`. |
| **500 `req.json is not a function`**     | Use `req.body` in Vercel background functions.                  |
| **`message_not_found`** on `chat.update` | Switched to `chat.postEphemeral`; passed `user` id.             |
| **Slash-command “operation\_timeout”**   | Moved placeholder into the initial `ack()`.                     |
