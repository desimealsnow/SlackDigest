import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import { OpenAI } from "openai";

/* ----------  ENV ---------- */
const signingSecret = process.env.SLACK_SIGNING_SECRET!;
const botToken      = process.env.SLACK_BOT_TOKEN!;
const openaiKey     = process.env.OPENAI_API_KEY!;


/* ----------  RECEIVER ---------- */
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  // POST /api/slack/event  →  slash-command dispatcher
  endpoints: { commands: "/api/slack/event" },
  processBeforeResponse: true
});


/* ── DEBUG #1: log ANY request that reaches Express ---------- */
receiver.app.use((req, _res, next) => {
  console.log(`[DEBUG] Incoming ${req.method} ${req.originalUrl}`);
  next();
});

/* Health-check for GET /api/slack/event */
receiver.app.get("/api/slack/event", (_req, res) => {
  console.log("[DEBUG] Health-check hit");
  res.status(200).json({ ok: true, ts: Date.now() });
});

/* ----------  BOLT APP ---------- */
const app = new App({
  token: botToken,
  receiver,
  logLevel: LogLevel.DEBUG       // extra Bolt diagnostics
});

/* ── /summarize command -------------------------------------- */
app.command("/summarize", async ({ ack, body, client, respond }) => {
  console.log("[DEBUG] /summarize invoked");
  await ack();
  const tmp = await client.chat.postEphemeral({
    channel: body.channel_id,
    user:    body.user_id,                            // ephemeral to requester
    text:    "📝 Summarising…"
  });
  const messageTs = (tmp as any).message_ts ?? tmp.ts;
  const oneDayAgo = Math.floor(Date.now() / 1000) - 60 * 60 * 24;
  const history   = await client.conversations.history({
    channel: body.channel_id,
    limit: 100,
    oldest: oneDayAgo.toString()
  });
  if (!history.ok) {
    await respond({
      replace_original: true,
      response_type: "ephemeral",
      text: `⚠️  Slack error – ${history.error}`
    });
    return;
  }
  const plain = (history.messages ?? [])
    .filter(m => !(m as any).subtype)
    .map(m => m.text ?? "")
    .join("\n")
    .slice(0, 4000);

  if (!plain) {
    await respond({ replace_original: true, text: "Nothing to summarise 👌" });
    return;
  }

  await fetch(`${process.env.VERCEL_URL}/api/slack/summarize`, {        // .background is implicit
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: body.channel_id, ts: messageTs, text: plain })
  });
});

/* ── DEBUG #2: catch-all 404 so we SEE what went unmatched ---- */
receiver.app.use((req, res) => {
  console.log(`[DEBUG] NO MATCH for ${req.method} ${req.originalUrl}`);
  res.status(404).json({ ok: false, route: req.originalUrl });
});

/* ----------  EXPORT ---------- */
export const config = { runtime: "nodejs" };
export default receiver.app;
