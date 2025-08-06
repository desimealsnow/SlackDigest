import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import { OpenAI } from "openai";
import pRetry from "p-retry";
import { WebClient } from "@slack/web-api";
import { performance } from "perf_hooks";

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

/* ──────────────────────────────────────────────────────────────── */
/* helper to time-limit any promise                                 */
/* ──────────────────────────────────────────────────────────────── */
function withTimeout<T>(p: Promise<T>, ms = 30_000) {
  return Promise.race<T>([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("openai_timeout")), ms)
    )
  ]);
}
console.log('Here')
/* ──────────────────────────────────────────────────────────────── */
/* LLM call with timeout + safe return                              */
/* ──────────────────────────────────────────────────────────────── */
const { choices } = await withTimeout(
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
console.log('Here1')

  
const summary = choices.at(0)?.message?.content?.trim() ?? "(empty)";
  console.log('Summary' )
  console.log(summary )

return summary;

}



/* ── /summarize command -------------------------------------- */
app.command("/summarize", async ({ ack, respond, body, client }) => {
  const t0 = performance.now();
  // 1️⃣ quick ack so Slack doesn’t timeout
  await ack({ response_type: "ephemeral", text: "📝 Summarising…" });
  console.log("[FLOW] ack sent in", (performance.now() - t0).toFixed(1), "ms");

  
  /* 2️⃣  Kick off the heavy work **without awaiting it** */
  (async () => {
    try {
      /* fetch recent messages ------------------------------------ */
      const oldest = Math.floor(Date.now() / 1000) - 60 * 60 * 24;
      console.time("[Slack] history");
      const hist   = await client.conversations.history({
        channel: body.channel_id,
        limit:   100,
        oldest:  oldest.toString()
      });
      console.timeEnd("[Slack] history");
      if (!hist.ok) throw new Error(`history_error:${hist.error}`);
      const text = (hist.messages ?? [])
        .filter(m => !(m as any).subtype)
        .map(m => m.text ?? "")
        .join("\n")
        .slice(0, 4000);

      if (!text) {
        await respond({
          replace_original: true,
          response_type: "ephemeral",
          text: "Nothing to summarise 👌"
        });
        return;
      }

 /* 2-B call LLM ------------------------------------------- */

      console.time("[LLM] latency");

      const summary = await Promise.race([
        generateSummary(text),
        new Promise<string>((_, rej) =>
          setTimeout(() => rej(new Error("openai_timeout")), 30_000)
        )
      ]);

      console.timeEnd("[LLM] latency");

      /* replace the temp message --------------------------------- */
      await respond({
        replace_original: true,
        response_type: "ephemeral",      // or "ephemeral"
        text: summary,
        ...(body.thread_ts && /^\d+\.\d+$/.test(body.thread_ts) && {
          thread_ts: body.thread_ts
        })
      });
      console.log(
        "[FLOW] respond() sent — total",
        (performance.now() - t0).toFixed(1),
        "ms"
      );
    } catch (err: any) {
      console.error("[ERR] summariser failed:", err);
      await respond({
        replace_original: true,
        response_type: "ephemeral",
        text: `⚠️  Sorry—${err.message ?? err}`
      });
    }
  })();  // ← launched & *not awaited*
});


/* ── DEBUG #2: catch-all 404 so we SEE what went unmatched ---- */
receiver.app.use((req, res) => {
  console.log(`[DEBUG] NO MATCH for ${req.method} ${req.originalUrl}`);
  res.status(404).json({ ok: false, route: req.originalUrl });
});

/* ----------  EXPORT ---------- */
export const config = { runtime: "nodejs" };
export default receiver.app;
