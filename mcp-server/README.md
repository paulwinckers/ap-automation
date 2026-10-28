# Darios CX — Claude Desktop connector

A local MCP server that lets Claude Desktop act as your **client-experience assistant**:
it reads what client emails are due, drafts them, and sends only the ones you approve.
It talks to the portal's existing API — it has no database access of its own.

## What Claude can do with it
- **list_due_actions** — the prioritised worklist (overdue → due → soon)
- **search_customers** / **get_customer_360** — find a customer and see their full picture
- **draft_email** — render an email from a template (no send)
- **send_email** — send for real; gated (needs your explicit approval, `confirmed=true`)
- **dismiss_action** — mark an action "not necessary"
- Prompt **cx_review** — one click to start the morning review

## One-time setup

1. **Install dependencies** (already done if you used the bundled `.venv`; otherwise):
   ```
   cd mcp-server
   python -m venv .venv
   .venv\Scripts\python.exe -m pip install -r requirements.txt
   ```

2. **Add it to Claude Desktop.** Open (create if missing):
   `%APPDATA%\Claude\claude_desktop_config.json`
   and add the `darios-cx` entry (merge into `mcpServers` if you already have one):
   ```json
   {
     "mcpServers": {
       "darios-cx": {
         "command": "C:\\Users\\Paul Winckers\\Documents\\ap-automation\\ap-automation\\mcp-server\\.venv\\Scripts\\python.exe",
         "args": ["C:\\Users\\Paul Winckers\\Documents\\ap-automation\\ap-automation\\mcp-server\\darios_cx_mcp.py"],
         "env": { "DARIOS_API": "https://ap-automation-production.up.railway.app" }
       }
     }
   }
   ```

3. **Restart Claude Desktop.** You should see the `darios-cx` tools (plug/🔨 icon). Try:
   > "Review the client emails that are due and help me send them."
   or run the **cx_review** prompt.

## How sending stays safe
`send_email` performs a real outbound email. Claude is instructed to draft first, show you
the recipient/subject/body, and send only after you say yes — and Claude Desktop also asks
you to approve each tool call. Nothing goes out without your go-ahead.

## ⚠️ Security note (recommended next step)
The portal API is currently open (no auth on the endpoints). This local connector is on
your machine, so it's contained — but the API itself is reachable by anyone with the URL,
including the send endpoint. Before rolling this out to staff, add an API key to the backend
and set it here as `DARIOS_API_KEY` (this server already sends it as `X-API-Key`).

## Hosted version — Claude Team custom connector

The same server runs on Railway so everyone on the darios.ca Claude Team can use it in chat,
Cowork and mobile. Each person signs in with their **Darios portal login**
(`oauth_provider.py`) and Claude acts as them — `whoami`, `get_my_worklist` etc. are theirs.
Deactivating someone in the portal cuts their Claude access immediately.

**Railway (one-time):** New service → GitHub repo → Settings → Root Directory `mcp-server`
(builds this folder's `Dockerfile`). Networking → Generate Domain. Variables:

| Var | Value |
|---|---|
| `DARIOS_API_KEY` | same value as the backend's `SERVICE_API_KEY` |
| `MCP_PUBLIC_URL` | the generated domain, e.g. `https://darios-mcp-production.up.railway.app` |
| `MCP_SIGNING_KEY` | a random 48+ char secret (rotating it signs everyone out) |

Check `https://<domain>/health` → `{"ok":true}`.

**Claude Team (Owner):** Admin settings → Connectors → Add custom connector →
URL `https://<domain>/mcp`. Then each person: Settings → Connectors → Darios CX → Connect →
signs in with their portal email + password.

Tokens are stateless (signed), so redeploys don't sign anyone out; access tokens last 1 h,
refresh 30 days. Only claude.ai / claude.com / localhost redirect URIs can register.
