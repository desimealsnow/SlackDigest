/*  slack-summariser-simple.ts  */
import { App, ExpressReceiver, LogLevel, RespondArguments } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { OpenAI } from "openai";

/* ────────────────  ENV  ──────────────── */
const signingSecret = process.env.SLACK_SIGNING_SECRET!;
const botToken      = process.env.SLACK_BOT_TOKEN!;

/* optional overrides */
const HISTORY_WINDOW_SEC = Number(process.env.SLACK_HISTORY_WINDOW_SEC ?? 60 * 60 * 24);
const HISTORY_LIMIT      = Number(process.env.SLACK_HISTORY_LIMIT ?? 100);

/* ─────────────  RECEIVER  ───────────── */
const receiver = new ExpressReceiver({
  signingSecret,
  endpoints: { commands: "/api/slack/event" },
  processBeforeResponse: false
});

receiver.app.get("/api/slack/event", (_req, res) =>
  res.status(200).json({ ok: true, ts: Date.now() })
);

/* ───────────────  APP  ──────────────── */
const app = new App({
  token: botToken,
  receiver,
  logLevel: LogLevel.DEBUG
});

/* ─────────── helper: messages ────────── */
async function fetchMessages(
  client: WebClient,
  channel: string,
  threadTs?: string
) {
  const oldest = Math.floor(Date.now() / 1000) - HISTORY_WINDOW_SEC;

  const res = threadTs
    ? await client.conversations.replies({ channel, ts: threadTs, limit: HISTORY_LIMIT })
    : await client.conversations.history({ channel, oldest: oldest.toString(), limit: HISTORY_LIMIT });

  if (!res.ok) throw new Error(`history_error:${(res as any).error}`);
  return (res.messages ?? []).filter(m => !(m as any).subtype);
}

/* ─────── helper: generate summary ────── */
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

  try {
    const resp = await chat.chat.completions.create({
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

    return resp.choices[0].message?.content?.trim() ?? "(empty)";
  } catch (err: any) {
    console.error("[ERR] LLM call failed:", err);
    await respond({
      replace_original: true,
      response_type: "ephemeral",
      text: `⚠️  LLM error – ${err.message}`
    });
    return undefined;
  }
}

/* ───────────  /summarize  ───────────── */
app.command("/summarize", async ({ ack, respond, body, client }) => {
  await ack({ response_type: "ephemeral", text: "📝 Summarising…" });

  try {
    const msgs  = await fetchMessages(client, body.channel_id, body.thread_ts);
    const text  = msgs.map(m => m.text ?? "").join("\n").slice(0, 4000);

    if (!text) {
      await respond({ replace_original: true, text: "Nothing to summarise 👌" });
      return;
    }

    const summary = await generateSummary(text, respond);
    if (!summary) return;            // error already handled

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

/* fallback 404 for stray hits */
receiver.app.use((req, res) =>
  res.status(404).json({ ok: false, route: req.originalUrl })
);

/* ─────────  EXPORTS (Vercel) ───────── */
export const config = { runtime: "nodejs" };
export default receiver.app;
