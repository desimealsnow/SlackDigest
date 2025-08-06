/*  slack-summariser.ts  */
import { App, ExpressReceiver, LogLevel, RespondArguments } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { OpenAI } from "openai";
import pRetry from "p-retry";

/* ─────────────────────────  ENV  ────────────────────────── */
const signingSecret = process.env.SLACK_SIGNING_SECRET!;
const botToken      = process.env.SLACK_BOT_TOKEN!;

/* Tunables (override in env without redeploy) */
const HISTORY_WINDOW_SEC = Number(process.env.SLACK_HISTORY_WINDOW_SEC ?? 60 * 60 * 24); // 24 h
const HISTORY_LIMIT      = Number(process.env.SLACK_HISTORY_LIMIT ?? 100);              // msgs
const LLM_TIMEOUT_MS     = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);               // 30 s

/* ──────────────────────  RECEIVER  ──────────────────────── */
const receiver = new ExpressReceiver({
  signingSecret,
  endpoints: { commands: "/api/slack/event" },
  processBeforeResponse: false
});

/* Log every inbound request (helps during first deploys) */
receiver.app.use((req, _res, next) => {
  console.log(`[DEBUG] Incoming ${req.method} ${req.originalUrl}`);
  next();
});

/* Health-check */
receiver.app.get("/api/slack/event", (_req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

/* ───────────────────────  BOLT APP  ─────────────────────── */
const app = new App({
  token: botToken,
  receiver,
  logLevel: LogLevel.DEBUG
});

/* ─────────── Helper: fetch recent Slack messages ────────── */
async function fetchMessages(
  client: WebClient,
  channel: string,
  threadTs?: string
) {
  const oldest = Math.floor(Date.now() / 1000) - HISTORY_WINDOW_SEC;

  return pRetry(
    async () => {
      console.time("[Slack] history RTT");
      const res = threadTs
        ? await client.conversations.replies({ channel, ts: threadTs, limit: HISTORY_LIMIT })
        : await client.conversations.history({ channel, oldest: oldest.toString(), limit: HISTORY_LIMIT });
      console.timeEnd("[Slack] history RTT");

      if (!res.ok) throw new Error(`history_error:${(res as any).error}`);
      return (res.messages ?? []).filter(m => !(m as any).subtype);
    },
    {
      retries: 1,
      minTimeout: 250,
      onFailedAttempt: err =>
        console.warn(`[Slack] history attempt ${err.attemptNumber} failed: ${err.message}`)
    }
  );
}

/* ───────────── Helper: generate LLM summary ─────────────── */
type SlackResponder = (msg: RespondArguments) => Promise<void>;

async function generateSummary(
  sourceText: string,
  respond: SlackResponder
): Promise<string | undefined> {
  const provider = (process.env.MODEL_PROVIDER ?? "openai").toLowerCase();
  const model =
    provider === "groq"
      ? process.env.GROQ_MODEL  ?? "llama3-8b-8192"
      : process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  const chat = new OpenAI(
    provider === "groq"
      ? { apiKey: process.env.GROQ_API_KEY!, baseURL: "https://api.groq.com/openai/v1" }
      : { apiKey: process.env.OPENAI_API_KEY! }
  );

  function withTimeout<T>(p: Promise<T>, ms = LLM_TIMEOUT_MS) {
    return Promise.race<T>([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("openai_timeout")), ms))
    ]);
  }

  console.log(`[LLM] provider=${provider.toUpperCase()} model=${model}`);
  console.time("[LLM] latency");
  try {
    const resp = await withTimeout(
      chat.chat.completions.create({
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
      })
    );
    console.timeEnd("[LLM] latency");
    return resp.choices[0].message?.content?.trim() ?? "(empty)";
  } catch (err: any) {
    console.timeEnd("[LLM] latency");
    console.error("[ERR] LLM call failed:", err);
    await respond({
      replace_original: true,
      response_type: "ephemeral",
      text:
        err.message === "openai_timeout"
          ? "⚠️  The model took longer than 30 s – try again shortly."
          : `⚠️  LLM error – ${err.message}`
    });
    return undefined;
  }
}

/* ───────────────  /summarize slash command  ─────────────── */
app.command("/summarize", async ({ ack, respond, body, client }) => {
  await ack({ response_type: "ephemeral", text: "📝 Summarising…" });

  try {
    const msgs = await fetchMessages(client, body.channel_id, body.thread_ts);
    const text = msgs.map(m => m.text ?? "").join("\n").slice(0, 4000); // safe cutoff

    if (!text) {
      await respond({ replace_original: true, text: "Nothing to summarise 👌" });
      return;
    }

    const summary = await generateSummary(text, respond);
    if (!summary) return; // error already handled

    await respond({
      replace_original: true,
      response_type: "in_channel",
      text: summary,
      ...(body.thread_ts && { thread_ts: body.thread_ts })
    });
  } catch (err: any) {
    console.error("[ERR] summariser failed:", err);
    await respond({
      replace_original: true,
      response_type: "ephemeral",
      text: `⚠️  Couldn’t summarise – ${err.message ?? err}`
    });
  }
});

/* ──────────── fallback 404 (diagnostics) ─────────────────── */
receiver.app.use((req, res) => {
  console.log(`[DEBUG] NO MATCH for ${req.method} ${req.originalUrl}`);
  res.status(404).json({ ok: false, route: req.originalUrl });
});

/* ───────────────────  EXPORTS  ───────────────────────────── */
export const config = { runtime: "nodejs" };  // Vercel / Netlify edge-hint
export default receiver.app;
