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
app.command("/summarize", async ({ ack, body, client }) => {
  console.log("[DEBUG] /summarize invoked");

  /* ①  ACK immediately *with* the placeholder text ------------- */
  await ack({
    response_type: "ephemeral",        // only the requester sees it
    text: "📝 Summarising…"
  });                                  // < 30 ms → Slack is happy

  /* ②  Gather messages (same as before) ------------------------ */
  const oneDayAgo = Math.floor(Date.now() / 1000) - 60 * 60 * 24;
  const history   = await client.conversations.history({
    channel: body.channel_id,
    limit:   100,
    oldest:  oneDayAgo.toString()
  });

  const plain = (history.messages ?? [])
    .filter(m => !(m as any).subtype)
    .map(m => m.text ?? "")
    .join("\n")
    .slice(0, 4000);

  if (!plain) {
    /* overwrite the placeholder with a quick reply ------------- */
    await client.chat.postEphemeral({
      channel: body.channel_id,
      user:    body.user_id,
      text:    "Nothing to summarise 👌"
    });
    return;
  }

  /* ③  Fire the background worker ----------------------------- */
  const origin  = `https://${process.env.VERCEL_URL}`;
  const headers: Record<string,string> = {
    "Content-Type": "application/json"
  };
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    headers["x-vercel-protection-bypass"] =
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  }

  await fetch(`${origin}/api/slack/summarize.background`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      channel: body.channel_id,
      user:    body.user_id,   // needed for chat.postEphemeral later
      text:    plain
    })
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
