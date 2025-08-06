import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import { OpenAI } from "openai";
import pRetry from "p-retry";
import { WebClient } from "@slack/web-api";

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

async function getRecentMessages(
  client: WebClient,
  channel: string,
  windowSeconds = 60 * 60 * 24       // 24 h
) {
  const oldest = Math.floor(Date.now() / 1000) - windowSeconds;

  return pRetry(
    async () => {
      console.time("[Slack] history RTT");
      const res = await client.conversations.history({
        channel,
        limit: 100,
        oldest: oldest.toString()
      });
      console.timeEnd("[Slack] history RTT");

      if (!res.ok) {
        throw new Error(`history_error:${res.error}`);
      }
      return res.messages ?? [];
    },
    {
      retries: 1,                    // total = 2 tries
      minTimeout: 250,
      onFailedAttempt: (err) =>
        console.warn(
          `[Slack] history attempt ${err.attemptNumber} failed: ${err.message}`
        )
    }
  );
}


async function generateSummary(sourceText: string): Promise<string> {
  /* pick provider + key + model from env ----------------------- */
  const provider = (process.env.MODEL_PROVIDER ?? "openai").toLowerCase();

  const chat = new OpenAI(
    provider === "groq"
      ? {
          apiKey: process.env.GROQ_API_KEY!,
          baseURL: "https://api.groq.com/openai/v1"  // Groq’s compat endpoint
        }
      : {
          apiKey: process.env.OPENAI_API_KEY!
        }
  );

  const model =
    provider === "groq"
      ? process.env.GROQ_MODEL  ?? "llama3-8b-8192"
      : process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  console.log(`[LLM] provider=${provider.toUpperCase()} model=${model}`);
  console.time("[LLM] latency");

  const { choices } = await chat.chat.completions.create({
    model,
    messages: [
      {
        role: "user",
        content:
          "Summarise the Slack discussion below in ≤120 words, " +
          "then list **Action Items** as bullets.\n\n" +
          sourceText
      }
    ],
    max_tokens: 400,
    temperature: 0.3
  });

  console.timeEnd("[LLM] latency");
  return choices.at(0)?.message?.content?.trim() ?? "(empty)";
}



/* ── /summarize command -------------------------------------- */
app.command("/summarize", async ({ ack, respond, body, client }) => {
  // 1️⃣ quick ack so Slack doesn’t timeout
  await ack({ response_type: "ephemeral", text: "📝 Summarising…" });

  
     const messages = await getRecentMessages(client, body.channel_id);
    console.log(`[Slack] fetched ${messages.length} messages`);

    if (!messages.length) {
      await respond({ replace_original: true, text: "Nothing to summarise 👌" });
      return;
    }
 
  try {

    /* 2️⃣ assemble plain text (truncate to avoid huge prompts) */
    const text = messages
      .filter((m) => !(m as any).subtype)
      .map((m) => m.text ?? "")
      .join("\n")
      .slice(0, 4000);

    if (!text) {
      await respond({
        response_type: "ephemeral",
        text: "Nothing to summarise in the last 24 h 👌"
      });
      return;
    }

    /* 3️⃣  call the LLM */
    const summary = await generateSummary(text);


    /* 4️⃣ replace temp message */
    await respond({
      replace_original: true,
      response_type: "in_channel",
      text: summary,
      ...(body.thread_ts && /^\d+\.\d+$/.test(body.thread_ts) && {
        thread_ts: body.thread_ts
      })
    });

  } catch (err: any) {
    console.error("[ERR] summariser failed", err);

    // graceful fallback so the user isn’t left hanging
    await respond({
      response_type: "ephemeral",
      text: "⚠️  Sorry—couldn’t generate that summary just now."
    });
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
