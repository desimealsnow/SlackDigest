import { WebClient } from "@slack/web-api";
import { OpenAI }   from "openai";

export const runtime = "nodejs";          // (optional) explicit

export default async function handler(req: Request) {
  const { channel, ts, text } = await req.json();   // payload from slash cmd

  /* ---------- OpenAI call (15-min budget) ---------- */
  const chat   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const { choices } = await chat.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    messages: [
      { role: "user",
        content:
          "Summarise the Slack discussion below in ≤120 words, " +
          "then list **Action Items** as bullets.\n\n" + text }
    ],
    max_tokens: 400,
    temperature: 0.3
  });

  const summary = choices.at(0)?.message?.content?.trim() ?? "(empty)";

  /* ---------- update the temp message in Slack ---------- */
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  await slack.chat.update({
    channel,
    ts,                     // message timestamp we stored earlier
    text: summary
  });

  return new Response("ok");   // ignored by caller, but good practice
}
