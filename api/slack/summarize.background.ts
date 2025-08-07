// /api/summarize.background.ts
import { WebClient } from "@slack/web-api";
import { OpenAI }    from "openai";

/* ——— helper: 30-second hard timeout ——— */
function withTimeout<T>(p: Promise<T>, ms = 30_000) {
  return Promise.race<T>([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("openai_timeout")), ms)
    )
  ]);
}

/* ——— background handler (15-min budget) ——— */
export default async function handler(req: Request) {
  if (req.method !== "POST")
    return new Response("Use POST", { status: 405 });

  const { channel, ts, text } = await req.json();

  /* 1️⃣  choose provider, key, model */
  const provider = (process.env.MODEL_PROVIDER ?? "openai").toLowerCase();

  const chat = new OpenAI(
    provider === "groq"
      ? {
          apiKey:  process.env.GROQ_API_KEY!,
          baseURL: "https://api.groq.com/openai/v1"
        }
      : {
          apiKey: process.env.OPENAI_API_KEY!
        }
  );

  const model =
    provider === "groq"
      ? process.env.GROQ_MODEL   ?? "llama3-8b-8192"
      : process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  console.log(`[LLM] provider=${provider} model=${model}`);

  /* 2️⃣  call the LLM (with timeout) */
  let summary: string;
  try {
    const { choices } = await withTimeout(
      chat.chat.completions.create({
        model,
        messages: [
          {
            role: "user",
            content:
              "Summarise the Slack discussion below in ≤120 words, " +
              "then list **Action Items** as bullets.\n\n" + text
          }
        ],
        max_tokens: 400,
        temperature: 0.3
      })
    );
    summary = choices.length
  ? choices[0].message?.content?.trim() ?? "(empty)"
  : "(empty)";
  } catch (err: any) {
    summary =
      err.message === "openai_timeout"
        ? "⚠️  OpenAI took longer than 30 s – try again later."
        : `⚠️  OpenAI error – ${err.message ?? err}`;
    console.error("[ERR] summariser failed:", err);
  }

  /* 3️⃣  update the original Slack message */
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  await slack.chat.update({
    channel,
    ts,            // timestamp of the “📝 Summarising…” message
    text: summary
  });

  /* 4️⃣  background functions must return a Response */
  return new Response(JSON.stringify({ ok: true }), {
    status: 202,
    headers: { "Content-Type": "application/json" }
  });
}
