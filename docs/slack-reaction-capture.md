# Slack Reaction-to-Capture Setup

**Problem:** Auto-capture from Slack logs duplicate messages and captures noise.
**Solution:** Only capture messages you explicitly react to with the 🧠 emoji.

---

## How It Works

You react to any Slack message with 🧠 → Slack sends a webhook to your Open Brain → it gets stored in Supabase as a thought. Nothing else is captured automatically.

---

## Step 1: Disable Your Current Auto-Capture

If you have a Slack workflow or Zapier/n8n automation that fires on every message:

- **Zapier:** Pause or delete the Zap that triggers on "New Message in Channel"
- **n8n:** Disable the workflow that was watching the Slack channel
- **Slack Workflow Builder:** Delete the existing "message posted" trigger workflow

---

## Step 2: Create the Reaction-to-Capture Workflow (Slack Workflow Builder)

Slack Workflow Builder is built into Slack — no external tools needed.

1. In Slack, click your workspace name → **Tools** → **Workflow Builder**
2. Click **New Workflow** → **Build Workflow**
3. **Add a trigger:** Choose **Emoji reaction added**
   - Emoji: `brain` (🧠)
   - Channel: Select the channel(s) you want to watch, or "Any channel"
4. **Add a step:** Choose **Send a webhook**
   - Webhook URL: `https://YOUR_PROJECT_ID.supabase.co/functions/v1/mcp` (your Open Brain MCP endpoint)
   - Method: POST
   - Headers:
     ```
     x-access-key: YOUR_OB1_ACCESS_KEY
     Content-Type: application/json
     ```
   - Body (use Slack's variable inserter to pull message text):
     ```json
     {
       "tool": "capture_thought",
       "params": {
         "content": "{{Message Text}}",
         "source": "slack",
         "tags": ["slack-capture"]
       }
     }
     ```
5. **Publish** the workflow

> **Note:** "Message Text" is a Slack variable available when the trigger is an emoji reaction on a message. Use the variable picker ({} icon) to insert it.

---

## Step 3: Alternatively, Use n8n or Zapier

If Workflow Builder's webhook step doesn't support the body format you need, use n8n:

### n8n Approach

1. **Trigger:** Slack → "Reaction Added" event (requires Slack app with `reactions:read` scope)
2. **Filter:** IF reaction emoji = `brain`
3. **HTTP Request:** POST to your Open Brain MCP endpoint with the message text

### Zapier Approach

1. **Trigger:** Slack → "New Reaction Added"
2. **Filter:** Only continue if Emoji Name = `brain`
3. **Action:** Webhooks by Zapier → POST to your Open Brain MCP endpoint

---

## Step 4: Test It

1. Post any message in the watched channel
2. React to it with 🧠
3. Check Supabase → your `thoughts` table for the new row
4. Or use Claude with your Open Brain MCP connected: ask it to `browse_recent_thoughts`

---

## Tips

- **Only react to things worth keeping.** The 🧠 reaction is your intentional capture signal.
- **Works across channels.** If you set "Any channel," you can capture from any conversation.
- **Works on others' messages too.** React to a colleague's message and it gets captured with their words.
- **Add context before reacting.** If you want to add a note, reply to the message first, then react to your own reply.
