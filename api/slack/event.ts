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
function vercelOrigin() {
  return  `https://${process.env.VERCEL_URL}`;                
}

/* -------------------------------------------------------------
 * FIRE BACKGROUND FUNCTION  (extra debugging)
 * ----------------------------------------------------------- */
try {
  const origin   = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`   // preview / prod
    : `https://${process.env.VERCEL_URL}`;             // vercel dev

  /* build request ------------------------------------------- */
  const url     = `${origin}/api/slack/summarize1`;
  const payload = {
    channel: body.channel_id,
    ts:      messageTs,        // “📝 Summarising…” message_ts
    text:    plain
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    headers["x-vercel-protection-bypass"] =
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  }

  /* log everything we’re about to send ---------------------- */
  console.log("[BG] URL      →", url);
  console.log("[BG] Headers  →", headers);
  console.log("[BG] Payload  →", JSON.stringify(payload).slice(0, 200) + "...");

  /* fire & await the response ------------------------------- */
  const bgResp = await fetch(url, {
    method:  "POST",
    headers,
    body:    JSON.stringify(payload)
  });

  /* log response status + any body text --------------------- */
  console.log("[BG] status   ←", bgResp.status);
  const dbgText = await bgResp.text().catch(() => "(no body)");
  console.log("[BG] body     ←", dbgText.slice(0, 200) + "...");

} catch (err) {
  console.error("[BG] fetch failed:", err);
  await respond({
    replace_original: true,
    response_type: "ephemeral",
    text: `⚠️  Couldn’t start background job – ${err}`
  });
  return;
}

});
/* ── DEBUG #2: catch-all 404 so we SEE what went unmatched ---- */
receiver.app.use((req, res) => {
  console.log(`[DEBUG] NO MATCH for ${req.method} ${req.originalUrl}`);
  res.status(404).json({ ok: false, route: req.originalUrl });
});

/* ----------  EXPORT ---------- */
export const config = { runtime: "nodejs" };
export default receiver.app;
