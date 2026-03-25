// Supabase Edge Function: daily-summary
// Queries recent Open Brain thoughts and sends a digest to Slack.
// Deploy with: supabase functions deploy daily-summary

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SLACK_WEBHOOK_URL = Deno.env.get("SLACK_DAILY_SUMMARY_WEBHOOK")!;
// Optional: restrict which callers can invoke this function
const ACCESS_KEY = Deno.env.get("OB1_ACCESS_KEY");

Deno.serve(async (req) => {
  // Simple key auth when called via cron webhook
  if (ACCESS_KEY) {
    const authHeader = req.headers.get("x-access-key");
    if (authHeader !== ACCESS_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Pull thoughts captured in the last 24 hours
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: thoughts, error } = await supabase
    .from("thoughts")
    .select("content, created_at, source, tags")
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Supabase query error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!thoughts || thoughts.length === 0) {
    console.log("No thoughts captured in the last 24 hours — skipping Slack message.");
    return new Response(JSON.stringify({ sent: false, reason: "no_thoughts" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Format the Slack message
  const dateLabel = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const thoughtLines = thoughts
    .map((t) => {
      const time = new Date(t.created_at).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      const tags = t.tags?.length ? ` _[${t.tags.join(", ")}]_` : "";
      const source = t.source ? ` *(${t.source})*` : "";
      return `• ${t.content}${tags}${source} — ${time}`;
    })
    .join("\n");

  const slackPayload = {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `🧠 Open Brain Daily Summary — ${dateLabel}`,
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${thoughts.length} thought${thoughts.length !== 1 ? "s" : ""} captured in the last 24 hours:*`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: thoughtLines,
        },
      },
      {
        type: "divider",
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Sent by Open Brain · React with 🧠 on any Slack message to capture it",
          },
        ],
      },
    ],
  };

  const slackRes = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(slackPayload),
  });

  if (!slackRes.ok) {
    const body = await slackRes.text();
    console.error("Slack webhook error:", body);
    return new Response(JSON.stringify({ error: "Slack delivery failed", detail: body }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({ sent: true, thought_count: thoughts.length }),
    { headers: { "Content-Type": "application/json" } }
  );
});
