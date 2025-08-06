import { OpenAI } from "openai";          // one SDK handles both clouds

/* ────────────────────────────────────────────────────────────── */
/*  1. Pick provider & keys from env                              */
/* ────────────────────────────────────────────────────────────── */
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
/* ────────────────────────────────────────────────────────────── */
/*  2. Call whichever model we just selected                     */
/* ────────────────────────────────────────────────────────────── */
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

const summaryText =
  choices.at(0)?.message?.content?.trim() ?? "(empty)";

/* ────────────────────────────────────────────────────────────── */
/*  3. Post back to Slack (thread-aware)                          */
/* ────────────────────────────────────────────────────────────── */
const threadTs =
  body.thread_ts && /^\d+\.\d+$/.test(body.thread_ts)
    ? body.thread_ts
    : undefined;

await client.chat.postMessage({
  channel: body.channel_id,
  text: summaryText,
  ...(threadTs && { thread_ts: threadTs })
});
