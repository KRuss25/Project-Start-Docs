// Supabase Edge Function: daily-summary
// Morning briefing with active client sections, upcoming events, and open loops.
// v7: LLM-based classification via OpenRouter for context-aware, intelligent categorization.
//     Replaces keyword matching — understands past tense, stale dates, false positives.
// Requires: OPENROUTER_API_KEY (already set for slack-capture — shared across all functions)
// Deploy with: supabase functions deploy daily-summary

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SLACK_WEBHOOK_URL = Deno.env.get("SLACK_DAILY_SUMMARY_WEBHOOK")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY");
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;

// --- Active client definitions ---
// Add new clients here as they come on board.
// aliases: all name variations to match against captured thoughts (lowercase)
// label: what appears in the briefing header
// prefix: business unit tag shown before client name
const CLIENTS = [
  // Practical Edge AI
  {
    label: "FedUp Foods",
    prefix: "[PE]",
    aliases: ["fedup foods", "fed up foods", "fed-up foods", "fedupfoods", "fedup"],
  },
  // Mountains to Sea Media
  {
    label: "RemSpec",
    prefix: "[MTS]",
    aliases: ["remspec", "rem spec", "remsspec"],
  },
  {
    label: "Deaton Builders",
    prefix: "[MTS]",
    aliases: ["deaton builders", "deaton"],
  },
  {
    label: "AAE",
    prefix: "[MTS]",
    aliases: ["aae", "a american", "a-american", "a american", "a&e american"],
  },
];

// --- Check if a thought mentions a known client ---
function matchClient(content: string): typeof CLIENTS[0] | null {
  const text = content.toLowerCase();
  for (const client of CLIENTS) {
    if (client.aliases.some((a) => text.includes(a))) return client;
  }
  return null;
}

// --- Fast pre-filter: skip obvious non-actionable items before the LLM call ---
// Reduces token cost — these are unambiguously not actionable.
function isObviousSkip(content: string): boolean {
  const text = content.toLowerCase().trim();
  if (text.includes("captured to open brain")) return true;
  if (content.trim().length < 20) return true;
  const signals = [
    "just wanted to log", "wanted to log", "logging this", "for the record",
    "today is march", "today is april", "today is january", "today is february",
    "today is may", "today is june", "today is july", "today is august",
    "today is september", "today is october", "today is november", "today is december",
  ];
  return signals.some((s) => text.includes(s));
}

// --- Fast pre-classifier: catch unambiguous completions before LLM ---
// Only catches things that are 100% clearly done — no edge cases.
function isObviousDone(content: string): boolean {
  const text = content.toLowerCase().trim();
  const clearPastTense = [
    "sent ", "finished ", "completed ", "received ", "deployed ",
    "delivered ", "submitted ", "signed ", "published ", "launched ",
  ];
  return clearPastTense.some((s) => text.startsWith(s));
}

// --- LLM batch classification ---
// Sends all candidate thoughts to gpt-4o-mini in a single call.
// Returns a map from array index → category.
type Category = "event" | "time_sensitive" | "waiting" | "open_task" | "done" | "skip";

async function batchClassify(
  items: Array<{ content: string; created_at: string }>,
  todayISO: string,
  todayHuman: string,
): Promise<Map<number, Category>> {
  const resultMap = new Map<number, Category>();
  if (items.length === 0) return resultMap;

  // Include capture date so the LLM can identify stale items
  const itemList = items
    .map((t, i) => {
      const date = t.created_at.split("T")[0]; // YYYY-MM-DD
      return `[${i}] (captured ${date}) ${t.content}`;
    })
    .join("\n");

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
          content: `You are preparing a focused morning briefing for a busy entrepreneur. Today is ${todayHuman} (${todayISO}).

Each thought shows the date it was captured. Use that to judge freshness and relevance.

Classify each as one of:
- "event": a future meeting, trip, or speaking engagement the person will attend
- "time_sensitive": has a specific upcoming deadline that hasn't passed yet
- "waiting": person is waiting on someone else's response or action
- "open_task": something they still need to do
- "done": already completed, past tense, or the referenced date has passed
- "skip": not actionable for today's briefing

Use your judgment like a smart assistant who knows this person's schedule:
- Past tense language (met with, sent, finished, received, approved, generated, created) → done
- Dates or weeks that have already passed → done
- A place name alone (Clemson, Charlotte) is not an event — only flag as event if they're clearly attending something upcoming
- Thoughts captured 2+ weeks ago with no future date or deadline → skip (they're background noise)
- Recent captures (last 7 days) with clear action language → open_task or waiting
- Aim for a tight, useful briefing. When genuinely uncertain, lean toward skip.

Return ONLY this JSON:
{"results": [{"index": 0, "category": "open_task"}, ...]}`,
        },
        { role: "user", content: itemList },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    console.error("OpenRouter classification error:", res.status, await res.text());
    return resultMap; // empty map → all items treated as "skip" (safe fallback)
  }

  const data = await res.json();
  try {
    const parsed = JSON.parse(data.choices[0].message.content);
    for (const item of (parsed.results ?? [])) {
      if (typeof item.index === "number" && typeof item.category === "string") {
        resultMap.set(item.index, item.category as Category);
      }
    }
  } catch (e) {
    console.error("LLM parse error:", e, JSON.stringify(data).slice(0, 500));
  }

  return resultMap;
}

// --- Topic fingerprint for deduplication ---
// Extracts the 5 most significant words as a topic fingerprint.
const stopWords = new Set([
  "the", "this", "that", "with", "have", "want", "need", "also", "just",
  "for", "and", "but", "from", "will", "been", "about", "some", "very",
  // Instruction/emphasis words that get appended but aren't topic-defining
  "forget", "remember", "please", "important", "noted", "dont", "note",
]);

function fingerprint(content: string): string {
  return content
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z]/g, ""))
    .filter((w) => w.length > 4 && !stopWords.has(w))
    .slice(0, 5)
    .sort()
    .join("-");
}

Deno.serve(async (req) => {
  if (MCP_ACCESS_KEY) {
    const authHeader = req.headers.get("x-brain-key");
    if (authHeader !== MCP_ACCESS_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

  // Date strings — must be defined before candidates filter and LLM call
  const now = new Date();
  const todayISO = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
  const todayHuman = now.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    timeZone: "America/New_York",
  });

  // Pre-filter only the unambiguous non-actionable items before LLM
  const candidates = thoughts.filter(
    (t) => !isObviousSkip(t.content) && !isObviousDone(t.content)
  );

  // LLM classify all candidates in a single API call
  const classifications = await batchClassify(candidates, todayISO, todayHuman);

  // --- Build output buckets ---
  const clientBuckets: Record<string, string[]> = {};
  for (const c of CLIENTS) clientBuckets[c.label] = [];

  const events: string[] = [];
  const waiting: string[] = [];
  const openTasks: string[] = [];
  const timeSensitive: string[] = [];
  const quickWins: string[] = [];

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const seenFingerprints = new Set<string>();

  function isDuplicate(content: string): boolean {
    const fp = fingerprint(content);
    if (seenFingerprints.has(fp)) return true;
    seenFingerprints.add(fp);
    return false;
  }

  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i];
    const category = classifications.get(i) ?? "skip";
    if (category === "skip" || category === "done") continue;

    const line = `• ${t.content}`;
    const capturedAt = new Date(t.created_at);
    const isRecent = capturedAt >= sevenDaysAgo;
    const client = matchClient(t.content);

    // Client items go ONLY into the client section (never in general sections)
    if (client) {
      if (!isDuplicate(t.content)) clientBuckets[client.label].push(line);
      continue;
    }

    if (isDuplicate(t.content)) continue;

    if (category === "event") events.push(line);
    else if (category === "waiting") waiting.push(line);
    else if (category === "time_sensitive") timeSensitive.push(line);
    else if (category === "open_task" && isRecent) quickWins.push(line);
    else if (category === "open_task") openTasks.push(line);
  }

  // Nothing actionable to send?
  const hasClients = CLIENTS.some((c) => clientBuckets[c.label].length > 0);
  const totalActionable = events.length + waiting.length + openTasks.length + timeSensitive.length + quickWins.length;
  if (!hasClients && totalActionable === 0) {
    console.log("Nothing actionable — skipping briefing.");
    return new Response(JSON.stringify({ sent: false, reason: "nothing_actionable" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const dateLabel = now.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
    timeZone: "America/New_York",
  });

  // --- Build Slack blocks ---
  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `🧠 Morning Briefing — ${dateLabel}`, emoji: true },
    },
  ];

  // Active Clients section
  const activeClientLines: string[] = [];
  for (const client of CLIENTS) {
    const items = clientBuckets[client.label];
    if (items.length > 0) {
      activeClientLines.push(`*${client.prefix} ${client.label}*`);
      activeClientLines.push(...items);
      activeClientLines.push(""); // spacing between clients
    }
  }
  if (activeClientLines.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*🏢 Active Clients*\n${activeClientLines.join("\n").trimEnd()}` },
    });
    blocks.push({ type: "divider" });
  }

  if (events.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*📅 Upcoming Events*\n${events.join("\n")}` },
    });
  }

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
    JSON.stringify({ sent: true }),
    { headers: { "Content-Type": "application/json" } },
  );
});
