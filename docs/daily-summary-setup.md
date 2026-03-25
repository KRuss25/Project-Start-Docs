# Daily Summary Setup Guide

A scheduled job queries your Open Brain for thoughts captured in the last 24 hours and sends a formatted digest to Slack every morning.

---

## Components

| File | Purpose |
|---|---|
| `supabase/functions/daily-summary/index.ts` | Edge function that queries Supabase and posts to Slack |
| `n8n/daily-summary-workflow.json` | n8n workflow that triggers the edge function on a schedule |

---

## Step 1: Add Environment Variables to Supabase

In your Supabase dashboard → **Project Settings** → **Edge Functions** → **Secrets**, add:

| Secret Name | Value |
|---|---|
| `SLACK_DAILY_SUMMARY_WEBHOOK` | Your Slack Incoming Webhook URL (see below) |
| `MCP_ACCESS_KEY` | Already set — this is the same key from your Open Brain MCP setup (Step 5 of Nate's guide) |

### Create the Slack Incoming Webhook

1. Go to `api.slack.com/apps` → select your workspace app (or create one)
2. **Incoming Webhooks** → Enable → **Add New Webhook to Workspace**
3. Choose the channel where you want the daily digest (e.g., `#brain-digest`)
4. Copy the webhook URL — paste it as `SLACK_DAILY_SUMMARY_WEBHOOK`

---

## Step 2: Deploy the Edge Function

From your terminal, in the project root:

```bash
# Install Supabase CLI if you haven't already
npm install -g supabase

# Login
supabase login

# Link to your project
supabase link --project-ref YOUR_PROJECT_ID

# Deploy the function
supabase functions deploy daily-summary
```

### Test it manually first

```bash
curl -X POST \
  https://YOUR_PROJECT_ID.supabase.co/functions/v1/daily-summary \
  -H "x-brain-key: YOUR_MCP_ACCESS_KEY"
```

You should see a Slack message appear (or `{"sent": false, "reason": "no_thoughts"}` if nothing was captured today yet).

---

## Step 3: Set Up the Cron Trigger in n8n

1. In n8n, go to **Workflows** → **Import** → paste or upload `n8n/daily-summary-workflow.json`
2. Open the **"Call Daily Summary Edge Function"** node and update:
   - URL: replace `YOUR_SUPABASE_PROJECT_ID` with your actual project ID
3. Set up the access key:
   - Go to n8n **Variables** (or use a Credential) and add `OB1_ACCESS_KEY`
   - Or hardcode it in the header value (less ideal)
4. Set your timezone in workflow **Settings** → **Timezone** (currently set to `America/Chicago`)
5. **Activate** the workflow

### Adjust the Schedule

The default cron `0 7 * * *` fires at **7:00am daily**. To change it:

| Time | Cron Expression |
|---|---|
| 6:00am daily | `0 6 * * *` |
| 8:30am daily | `30 8 * * *` |
| 7am weekdays only | `0 7 * * 1-5` |

---

## Step 4: Verify End-to-End

1. Capture a few thoughts via Claude or Slack 🧠 reaction
2. Trigger the n8n workflow manually (click **Execute Workflow**)
3. Check your Slack channel for the digest
4. Once confirmed, the scheduled trigger takes over automatically

---

## What the Digest Looks Like in Slack

```
🧠 Open Brain Daily Summary — Wednesday, March 25

3 thoughts captured in the last 24 hours:

• Need to follow up with the vendor on API pricing [slack-capture] (slack) — 9:42 AM
• Idea: weekly review template based on my OKRs — 2:15 PM
• The n8n + Supabase pattern is cleaner than Zapier for stateful flows — 4:33 PM

────────────────────────────────────
Sent by Open Brain · React with 🧠 on any Slack message to capture it
```

---

## Troubleshooting

**No Slack message received:**
- Check the n8n execution log for HTTP errors
- Test the edge function manually with curl (Step 2)
- Confirm `SLACK_DAILY_SUMMARY_WEBHOOK` is set correctly in Supabase secrets

**Edge function returns 500:**
- Check Supabase **Edge Functions** → **Logs** for the error
- Confirm your `thoughts` table has `content`, `created_at`, and `metadata` columns (standard OB1 schema)

**"Unauthorized" response:**
- The `x-brain-key` header doesn't match `MCP_ACCESS_KEY` in your Supabase secrets
