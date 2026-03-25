// Supabase Edge Function: slack-capture
// Receives Slack Event Subscriptions and captures messages to Open Brain.
//
// KEY FIX FOR DUPLICATES:
// Slack retries the webhook if it doesn't get a 200 within 3 seconds.
// Embedding + LLM metadata extraction takes 3–8 seconds.
// Solution: respond 200 immediately, then process async via waitUntil().
// Also deduplicates using Slack's event_id to handle any remaining retries.
//
// Deploy with: supabase functions deploy slack-capture --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const SLACK_SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET")!;
// Optional: only capture from a specific channel ID (e.g. "C12345678")
// Leave empty to capture from all channels the app is in.
const CAPTURE_CHANNEL_ID = Deno.env.get("SLACK_CAPTURE_CHANNEL_ID") ?? "";
// Optional: emoji reaction name to trigger capture (e.g. "brain")
// If set, only messages reacted to with this emoji are captured.
// If empty, all messages in the channel are captured.
const CAPTURE_REACTION = Deno.env.get("SLACK_CAPTURE_REACTION") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Slack request signature verification ---
async function verifySlackSignature(req: Request, body: string): Promise<boolean> {
  const timestamp = req.headers.get("x-slack-request-timestamp");
  const signature = req.headers.get("x-slack-signature");
  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes (replay attack protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const sigBaseString = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sigBaseString));
  const computed =
    "v0=" +
    Array.from(new Uint8Array(sigBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  return computed === signature;
}

// --- Generate embedding via OpenRouter ---
async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  const data = await res.json();
  return data.data[0].embedding;
}

// --- Extract metadata via OpenRouter LLM ---
async function extractMetadata(content: string): Promise<Record<string, unknown>> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Extract structured metadata from a thought or note. Return JSON only.
Schema:
{
  "type": "observation" | "task" | "idea" | "reference" | "person_note",
  "topics": string[],
  "people": string[],
  "action_items": string[],
  "source": "slack"
}`,
        },
        { role: "user", content },
      ],
      response_format: { type: "json_object" },
    }),
  });
  const data = await res.json();
  try {
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return { type: "observation", topics: [], people: [], action_items: [], source: "slack" };
  }
}

// --- Check for duplicate using Slack event_id stored in metadata ---
async function isDuplicate(slackEventId: string): Promise<boolean> {
  const { data } = await supabase
    .from("thoughts")
    .select("id")
    .eq("metadata->>slack_event_id", slackEventId)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

// --- Main capture logic (runs async after 200 is returned) ---
async function captureThought(text: string, slackEventId: string): Promise<void> {
  // Deduplication check — handles Slack retries that slipped through
  if (await isDuplicate(slackEventId)) {
    console.log(`Duplicate event skipped: ${slackEventId}`);
    return;
  }

  const [embedding, metadata] = await Promise.all([
    getEmbedding(text),
    extractMetadata(text),
  ]);

  const { error } = await supabase.from("thoughts").insert({
    content: text,
    embedding,
    metadata: { ...metadata, slack_event_id: slackEventId, source: "slack" },
  });

  if (error) {
    console.error("Insert error:", error);
  } else {
    console.log(`Captured thought (event: ${slackEventId})`);
  }
}

// --- HTTP handler ---
Deno.serve(async (req) => {
  const body = await req.text();

  // Verify Slack signature
  if (!(await verifySlackSignature(req, body))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payload = JSON.parse(body);

  // Slack URL verification challenge (one-time during app setup)
  if (payload.type === "url_verification") {
    return new Response(JSON.stringify({ challenge: payload.challenge }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Handle message events
  if (payload.type === "event_callback") {
    const event = payload.event;
    const eventId: string = payload.event_id;

    let shouldCapture = false;
    let messageText = "";

    if (CAPTURE_REACTION) {
      // Reaction-to-capture mode: only capture on specific emoji reaction
      if (
        event.type === "reaction_added" &&
        event.reaction === CAPTURE_REACTION
      ) {
        // Fetch the original message text
        // In a full implementation you'd call Slack's conversations.history API here.
        // For simplicity, use the item text if available, or log that a lookup is needed.
        messageText = event.item?.text ?? "";
        shouldCapture = !!messageText;
      }
    } else {
      // Auto-capture mode: capture all messages in the configured channel
      if (
        event.type === "message" &&
        !event.subtype && // exclude edits, deletions, bot messages
        event.text &&
        event.text.trim().length > 0
      ) {
        if (!CAPTURE_CHANNEL_ID || event.channel === CAPTURE_CHANNEL_ID) {
          messageText = event.text;
          shouldCapture = true;
        }
      }
    }

    if (shouldCapture) {
      // *** THE CRITICAL FIX ***
      // Return 200 to Slack IMMEDIATELY, then process async.
      // EdgeRuntime.waitUntil keeps the function alive after the response is sent.
      EdgeRuntime.waitUntil(captureThought(messageText, eventId));
    }
  }

  // Always return 200 quickly — Slack requires this within 3 seconds
  return new Response("ok", { status: 200 });
});
