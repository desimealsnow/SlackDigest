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
  processBeforeResponse: false
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
  await ack({ response_type: "ephemeral", text: "📝 Summarising…" });

  const oneDayAgo = Math.floor(Date.now() / 1000) - 60 * 60 * 24;
  const history   = await client.conversations.history({
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

  const provider   = (process.env.MODEL_PROVIDER ?? "openai").toLowerCase();
  const chat = new OpenAI(
    provider === "groq"
      ? {
          apiKey: process.env.GROQ_API_KEY!,                   // GROQ_API_KEY in Vercel
          baseURL: "https://api.groq.com/openai/v1"            // Groq’s OpenAI-compatible endpoint
        }
      : {
          apiKey: process.env.OPENAI_API_KEY!,                 // OPENAI_API_KEY in Vercel
          /* baseURL defaults to api.openai.com */
        }
  );
  const model =
    provider === "groq"
      ? process.env.GROQ_MODEL  ?? "llama3-8b-8192"            // cheap dev model
      : process.env.OPENAI_MODEL ?? "gpt-4o-mini";             // prod default  
  console.log(
    `[LLM] provider=${provider.toUpperCase()} model=${model}`
  );
  console.time("[LLM] latency");   // start timer
  const { choices } = await chat.chat.completions.create({
    model,
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
  console.timeEnd("[LLM] latency"); // prints elapsed ms
  const summaryText = choices[0].message?.content?.trim() ?? "(empty)";
  const threadTs =
  // if the command was used *inside* an existing thread
  (body.thread_ts && /^\d+\.\d+$/.test(body.thread_ts))
    ? body.thread_ts
    : undefined;
  await client.chat.postMessage({
    channel: body.channel_id,
    text: summaryText,
    ...(threadTs && { thread_ts: threadTs })   // spread only if defined
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
