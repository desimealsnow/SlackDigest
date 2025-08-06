import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import { OpenAI } from "openai";

/* ----------  Slack & OpenAI credentials  ---------- */
const signingSecret = process.env.SLACK_SIGNING_SECRET!;
const botToken      = process.env.SLACK_BOT_TOKEN!;
const openaiKey     = process.env.OPENAI_API_KEY!;

/* ----------  Express receiver (Vercel-friendly)  ---------- */
const receiver = new ExpressReceiver({
  signingSecret,
  endpoints: { commands: "/" },   // POST /  →  /summarize command
  processBeforeResponse: true
});

/* 👉 add a GET handler on the root of the *app* */
receiver.app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    message: "Slack Digest Bot is alive ✨",
    ts: Date.now()
  });
});

/* ----------  Bolt app  ---------- */
const app = new App({
  token: botToken,
  receiver,
  logLevel: LogLevel.INFO
});

/* ----------  /summarize command  ---------- */
app.command("/summarize", async ({ ack, body, client, respond }) => {
  await ack({ response_type: "ephemeral", text: "📝 Summarising…" });

  const oneDayAgo = Math.floor(Date.now() / 1000) - 60 * 60 * 24;

  const history = await client.conversations.history({
    channel: body.channel_id,
    limit: 100,
    oldest: oneDayAgo.toString()
  });

  const text = (history.messages ?? [])
    .filter(m => !(m as any).subtype)
    .map(m => m.text ?? "")
    .join("\n");

  if (!text) {
    await respond({ response_type: "ephemeral", text: "Nothing to summarise 👌" });
    return;
  }

  const openai = new OpenAI({ apiKey: openaiKey });
  const { choices } = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content:
          "Summarise the Slack discussion below in ≤120 words, then list **Action Items** as bullets.\n\n" +
          text
      }
    ],
    max_tokens: 400,
    temperature: 0.3
  });

  await client.chat.postMessage({
    channel: body.channel_id,
    thread_ts: body.thread_ts ?? body.trigger_id,
    text: choices[0].message?.content?.trim() ?? "(empty)"
  });
});

/* ----------  Vercel export  ---------- */
export const config = { runtime: "nodejs" };
export default receiver.app;
