// Supabase Edge Function: daily-summary
// Sends a morning briefing to Slack organized by open loops, not raw log.
// Deploy with: supabase functions deploy daily-summary

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SLACK_WEBHOOK_URL = Deno.env.get("SLACK_DAILY_SUMMARY_WEBHOOK")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY");

// --- Classify a thought into briefing sections ---
// Returns one of: "waiting" | "open_task" | "time_sensitive" | "quick_win" | "done" | "skip"
function classify(content: string): string {
  const text = content.toLowerCase();

  // Skip — bot artifacts or very short
  if (text.includes("captured to open brain") || content.trim().length < 20) return "skip";

  // Skip — historical logs (past tense, date stamping, "just wanted to log")
  const historySignals = [
    "just wanted to log", "wanted to log", "logging this", "for the record",
    "on march ", "on april ", "on january ", "on february ", "on may ", "on june ",
    "on july ", "on august ", "on september ", "on october ", "on november ", "on december ",
    "today is march", "today is april", "today is january",
    "i changed ", "i put ", "i moved ", "i added ", "i removed ", "i updated ",
  ];
  if (historySignals.some((s) => text.includes(s))) return "skip";

  // Skip — already done signals
  const doneSignals = [
    "sent ", "finished ", "completed ", "updated ", "done ", "delivered ",
    "pushed ", "deployed ", "submitted ", "finally sent", "just sent",
  ];
  if (doneSignals.some((s) => text.includes(s))) return "done";

  // Waiting on others
  const waitingSignals = [
    "waiting", "awaiting", "should be getting", "haven't heard", "pending",
    "expecting", "supposed to", "to hear from", "from charlie", "from david",
    "from blake", "from pierce", "from tyler",
  ];
  if (waitingSignals.some((s) => text.includes(s))) return "waiting";

  // Time-sensitive — future dates and deadlines only
  const futureDateSignals = [
    "by april", "by may", "by june", "by the end of",
    "next thursday", "next monday", "next tuesday", "next wednesday", "next friday",
    "this thursday", "this monday", "this tuesday", "this wednesday", "this friday",
    "before thursday", "before monday", "before friday",
    "april 1", "april 7", "april 8", "april 14", "april 15", "april 17",
    "week of the 30th", "week of march 30", "end of may",
    "deadline", "due date",
  ];
  if (futureDateSignals.some((s) => text.includes(s))) return "time_sensitive";

  // Open task signals
  const taskSignals = [
    "need to", "i need", "have to", "want to", "should ", "must ",
    "going to", "i want", "priority", "i have to", "follow up", "follow-up",
    "reach out", "get together", "work on", "build ", "make it",
  ];
  if (taskSignals.some((s) => text.includes(s))) return "open_task";

  return "skip";
}

Deno.serve(async (req) => {
  if (MCP_ACCESS_KEY) {
    const authHeader = req.headers.get("x-brain-key");
    if (authHeader !== MCP_ACCESS_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Pull last 30 days for open loops, last 7 for quick wins
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: thoughts, error } = await supabase
    .from("thoughts")
    .select("content, created_at, metadata")
    .gte("created_at", since30)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Supabase query error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!thoughts || thoughts.length === 0) {
    return new Response(JSON.stringify({ sent: false, reason: "no_thoughts" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Bucket thoughts into sections
  const waiting: string[] = [];
  const openTasks: string[] = [];
  const timeSensitive: string[] = [];
  const quickWins: string[] = [];

  for (const t of thoughts) {
    const bucket = classify(t.content);
    const isRecent = new Date(t.created_at) >= sevenDaysAgo;
    const line = `• ${t.content}`;

    if (bucket === "waiting") waiting.push(line);
    else if (bucket === "time_sensitive") timeSensitive.push(line);
    else if (bucket === "open_task" && isRecent) quickWins.push(line);
    else if (bucket === "open_task") openTasks.push(line);
  }

  // Skip sending if nothing actionable
  const totalActionable = waiting.length + openTasks.length + timeSensitive.length + quickWins.length;
  if (totalActionable === 0) {
    console.log("Nothing actionable — skipping briefing.");
    return new Response(JSON.stringify({ sent: false, reason: "nothing_actionable" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const dateLabel = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  // Build Slack blocks
  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🧠 Morning Briefing — ${dateLabel}`,
        emoji: true,
      },
    },
  ];

  if (timeSensitive.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*⏰ Time-Sensitive*\n${timeSensitive.join("\n")}` },
    });
  }

  if (waiting.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*👀 Waiting on Others*\n${waiting.join("\n")}` },
    });
  }

  if (quickWins.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*⚡ Quick Wins (this week)*\n${quickWins.join("\n")}` },
    });
  }

  if (openTasks.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*📋 Open Tasks*\n${openTasks.join("\n")}` },
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "Sent by Open Brain · Capture thoughts in Slack with 🧠" }],
  });

  const slackRes = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocks }),
  });

  if (!slackRes.ok) {
    const detail = await slackRes.text();
    console.error("Slack webhook error:", detail);
    return new Response(JSON.stringify({ error: "Slack delivery failed", detail }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({ sent: true, sections: { time_sensitive: timeSensitive.length, waiting: waiting.length, quick_wins: quickWins.length, open_tasks: openTasks.length } }),
    { headers: { "Content-Type": "application/json" } }
  );
});
