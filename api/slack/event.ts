// api/slack/events.ts
import { AwsLambdaReceiver, App } from "@slack/bolt";
import { OpenAI } from "openai";

// Slack signs every request → we verify with AwsLambdaReceiver
const awsReceiver = new AwsLambdaReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: awsReceiver
});

/* /summarize slash command */
app.command("/summarize", async ({ ack, body, client, respond }) => {
  await ack();

  const channelId = body.channel_id;
  const now = Math.floor(Date.now() / 1000);

  /* 1️⃣ fetch 24 h history (100 msgs max) */
  const history = await client.conversations.history({
    channel: channelId,
    limit: 100,
    oldest: (now - 60 * 60 * 24).toString()
  });

  const msgs = (history.messages ?? [])
    .filter(m => !(m as any).subtype)
    .map(m => (m.text ?? "").replace(/\n+/g, " "))
    .join("\n");

  if (!msgs) {
    await respond({ response_type: "ephemeral", text: "Nothing to summarise 👌" });
    return;
  }

  /* 2️⃣ call OpenAI */
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const prompt =
    "Summarise the Slack discussion below in <=120 words, then list \"Action Items\" as bullets.\n### Slack messages\n" +
    msgs;

  const { choices } = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 400,
    temperature: 0.3
  });

  const summary = choices[0]?.message?.content?.trim() ?? "(empty)";

  /* 3️⃣ post threaded reply */
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: body.thread_ts ?? body.trigger_id,
    text: `*Here’s your summary:* \n${summary}`
  });
});

/* Vercel wrapper */
export const config = { runtime: "nodejs" };
export default awsReceiver.toLambda();
