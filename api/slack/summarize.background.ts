// api/slack/summarize.background.ts
import { WebClient } from "@slack/web-api";
import { OpenAI }     from "openai";
import type { VercelRequest, VercelResponse } from "@vercel/node";

/* 15-min background handler ---------------------------------- */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== "POST") {
    res.status(405).send("Use POST");
    return;
  }

  /* ①  parse JSON body (Vercel automatically parsed it for us) */
  const { channel, ts, text } = req.body as {
    channel: string;
    ts:      string;
    text:    string;
    user:    string;
  };

  /* ②  choose provider / model (unchanged) ------------------- */
  const provider = (process.env.MODEL_PROVIDER ?? "openai").toLowerCase();
  const chat = new OpenAI(
    provider === "groq"
      ? {
          apiKey:  process.env.GROQ_API_KEY!,
          baseURL: "https://api.groq.com/openai/v1"
        }
      : { apiKey: process.env.OPENAI_API_KEY! }
  );
  const model =
    provider === "groq"
      ? process.env.GROQ_MODEL   ?? "llama3-8b-8192"
      : process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  /* ③  call the LLM ---------------------------------------- */
  let summary = "(empty)";
  try {
    const { choices } = await chat.chat.completions.create({
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
    });
    summary = (choices[0]?.message?.content ?? "(empty)").trim();
  } catch (err: any) {
    console.error("[ERR] LLM failed:", err);
    summary = `⚠️  LLM error – ${err.message ?? err}`;
  }

  /* ④  update Slack message -------------------------------- */
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  await slack.chat.postEphemeral({ channel,  user:  userId , text: summary });

  /* ⑤  respond 202 so Vercel is happy ----------------------- */
  res.status(202).json({ ok: true });
}
