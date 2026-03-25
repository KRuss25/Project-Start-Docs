# Fixing Duplicate Slack Captures

## Root Cause

Slack requires your webhook endpoint to respond with HTTP 200 **within 3 seconds**.
Your Open Brain capture process (embedding generation + LLM metadata extraction) takes **3–8 seconds**.

Slack sees no response → assumes failure → **retries the same event 2–3 times** → same thought captured multiple times.

This is confirmed by the live data: the same FedUp Foods meeting thought appears 3 times with slightly different topic tags (the LLM classified topics slightly differently on each retry).

---

## The Fix: `slack-capture` Edge Function

File: `supabase/functions/slack-capture/index.ts`

Two changes from a naive implementation:

### 1. Return 200 immediately, process async

```ts
// *** THE CRITICAL FIX ***
EdgeRuntime.waitUntil(captureThought(messageText, eventId));

// Always return 200 quickly — Slack requires this within 3 seconds
return new Response("ok", { status: 200 });
```

`EdgeRuntime.waitUntil()` keeps the function alive after the HTTP response is sent.
Slack gets its 200. No more retries.

### 2. Deduplicate using Slack's `event_id`

Each Slack event has a unique `event_id`. Even if a retry slips through, the second call checks the database first:

```ts
async function isDuplicate(slackEventId: string): Promise<boolean> {
  const { data } = await supabase
    .from("thoughts")
    .select("id")
    .eq("metadata->>slack_event_id", slackEventId)
    .limit(1);
  return (data?.length ?? 0) > 0;
}
```

The `slack_event_id` is stored inside the `metadata` JSONB field on every captured thought.

---

## Deploy Steps

### Step 1: Add the new Supabase secret

```bash
supabase secrets set SLACK_SIGNING_SECRET=your-slack-app-signing-secret
```

Find your signing secret: `api.slack.com/apps` → your app → **Basic Information** → **App Credentials** → Signing Secret.

### Step 2: Optional — configure capture mode

To use **reaction-to-capture** (recommended — see `docs/slack-reaction-capture.md`):

```bash
supabase secrets set SLACK_CAPTURE_REACTION=brain
```

To restrict auto-capture to a specific channel:

```bash
supabase secrets set SLACK_CAPTURE_CHANNEL_ID=C12345678
```

Leave both unset for auto-capture from all channels (not recommended).

### Step 3: Deploy

```bash
supabase functions deploy slack-capture --no-verify-jwt
```

Your new endpoint URL:
```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/slack-capture
```

### Step 4: Update your Slack app's Event Subscriptions URL

In `api.slack.com/apps` → your app → **Event Subscriptions**:
- Update the **Request URL** to your new endpoint
- Slack will send a `url_verification` challenge — the function handles it automatically

### Step 5: Clean up existing duplicates (optional)

The three duplicate FedUp Foods thoughts currently in your brain can be deduplicated with this SQL in the Supabase SQL Editor:

```sql
-- Preview duplicates first
SELECT content, COUNT(*) as count, array_agg(id) as ids
FROM thoughts
GROUP BY content
HAVING COUNT(*) > 1;

-- Delete duplicates, keeping the earliest capture of each
DELETE FROM thoughts
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY content ORDER BY created_at ASC) as rn
    FROM thoughts
  ) ranked
  WHERE rn > 1
);
```

---

## Switching to Reaction-to-Capture Instead

If you'd rather not run auto-capture at all (the recommended approach):

1. Set `SLACK_CAPTURE_REACTION=brain` in Supabase secrets
2. In your Slack app's Event Subscriptions, subscribe to `reaction_added` instead of `message.channels`
3. React to any Slack message with 🧠 to capture it

See `docs/slack-reaction-capture.md` for the full Slack Workflow Builder approach (no Edge Function needed for basic reaction capture).
