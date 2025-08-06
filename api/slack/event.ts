// api/slack/events.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { AwsLambdaReceiver, App, LogLevel } from '@slack/bolt';
import { OpenAI } from 'openai';

// ---------- initialise Bolt ----------
const awsReceiver = new AwsLambdaReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: awsReceiver,
  logLevel: LogLevel.INFO
});

// --- slash command ---
app.command('/summarize', async ({ ack, body, client, respond }) => {
  await ack();

  const now = Math.floor(Date.now() / 1000);
  const hist = await client.conversations.history({
    channel: body.channel_id,
    limit: 100,
    oldest: (now - 60 * 60 * 24).toString()
  });

  const text = (hist.messages ?? [])
    .filter(m => !(m as any).subtype)
    .map(m => m.text ?? '')
    .join('\n');

  if (!text) {
    await respond({ response_type: 'ephemeral', text: 'Nothing to summarise 👌' });
    return;
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { choices } = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content:
          'Summarise the Slack discussion below in ≤120 words, then list **Action Items** as bullets.\n\n' +
          text
      }
    ],
    max_tokens: 400,
    temperature: 0.3
  });

  await client.chat.postMessage({
    channel: body.channel_id,
    thread_ts: body.thread_ts ?? body.trigger_id,
    text: choices[0].message?.content?.trim() ?? '(empty)'
  });
});

// ---------- Vercel adapter ----------
// Bolt already ships a Lambda-style handler:
const lambdaHandlerPromise = awsReceiver.start();  // returns Promise<handler> :contentReference[oaicite:0]{index=0}

export const config = { runtime: 'nodejs' };

export default async function vercelHandler(req: VercelRequest, res: VercelResponse) {
  // Convert Vercel’s IncomingMessage to the shape the Lambda handler expects.
  const rawBody = await buffer(req);
  const handler = await lambdaHandlerPromise;
  return handler(
    {
      body: rawBody.toString(),
      headers: req.headers as Record<string, string>,
      httpMethod: req.method,
      isBase64Encoded: false,
      path: req.url,
      queryStringParameters: req.query as Record<string, string>
    },
    // minimal context stub
    { awsRequestId: 'vercel' } as any,
    // callback that ends the response on success/fail
    (_err: any, lambdaRes: { statusCode: number; headers?: any; body: any }) => {
      res.status(lambdaRes.statusCode).set(lambdaRes.headers || {}).send(lambdaRes.body);
    }
  );
}

// tiny helper
import { IncomingMessage } from 'http';
function buffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req
      .on('data', (chunk: Buffer) => chunks.push(chunk))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
  });
}
