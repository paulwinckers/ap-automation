"""
Darios CX — a local MCP server for Claude Desktop.

Turns the portal into tools Claude can use so you can say "review the client emails
that are due and help me send them." Claude reads the worklist, drafts each email,
and sends only the ones you approve.

It talks to the portal's existing HTTP API (no database access of its own):
  - GET  /construction/cx/action-review          → what's due (the worklist)
  - GET  /customer/search                          → find a customer (company or contact)
  - GET  /customer/{id}/360 | /customer/contact/{id}/360  → one customer's full picture
  - POST /construction/cx/project/{opp}/render     → draft an email (no send)
  - POST /construction/cx/project/{opp}/send       → SEND an email (gated)
  - POST /construction/cx/skip                     → dismiss an action as not necessary

Run it from Claude Desktop (see README.md). Config via env vars:
  DARIOS_API      base URL (default: the production backend)
  DARIOS_API_KEY  optional; sent as X-API-Key if the API later requires it
"""
import os
from typing import Optional

import httpx
from mcp.server.fastmcp import FastMCP

API = os.environ.get("DARIOS_API", "https://ap-automation-production.up.railway.app").rstrip("/")
KEY = os.environ.get("DARIOS_API_KEY", "")
TIMEOUT = 120.0

mcp = FastMCP("Darios CX")


def _headers() -> dict:
    return {"X-API-Key": KEY} if KEY else {}


async def _get(path: str, params: dict | None = None):
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.get(f"{API}{path}", params=params, headers=_headers())
        r.raise_for_status()
        return r.json()


async def _post(path: str, body: dict):
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(f"{API}{path}", json=body, headers=_headers())
        r.raise_for_status()
        return r.json()


# ── Read tools (safe) ──────────────────────────────────────────────────────────

@mcp.tool()
async def list_due_actions() -> dict:
    """List every client-communication action currently due across construction jobs,
    prioritised overdue → due → soon. Start here. Each item has: opportunity_id, the
    job/property, the action (e.g. 'Send welcome email'), its severity, the suggested
    template_key, and when that template was last sent. Several jobs on the same
    property are separate items — group them by property when presenting to the user."""
    return await _get("/construction/cx/action-review")


@mcp.tool()
async def search_customers(query: str) -> dict:
    """Find a customer by name. Returns `results`, each {kind: 'company'|'contact', id,
    name, sub}. Use the id + kind with get_customer_360."""
    return await _get("/customer/search", {"q": query})


@mcp.tool()
async def get_customer_360(kind: str, id: int) -> dict:
    """The full picture of one customer: contacts, properties, every job across all
    divisions, and the portal activity attached (stage, schedule, prep, PHA, comms) plus
    an activity timeline. `kind` is 'company' or 'contact'; `id` is from search_customers."""
    path = f"/customer/contact/{id}/360" if kind == "contact" else f"/customer/{id}/360"
    return await _get(path)


@mcp.tool()
async def get_work_tickets(opportunity_id: int) -> dict:
    """Work tickets (site visits) for one job, from Aspire: each ticket's status,
    scheduled/complete dates, crew leader, estimated vs actual hours and cost, and visit
    notes — plus roll-up totals. Use the opportunity_id from list_due_actions or a
    customer's jobs (get_customer_360) to answer questions like 'what's the status of job
    X', 'how many hours have we logged', or 'what did the crew note on the last visit'."""
    return await _get(f"/customer/opportunity/{opportunity_id}/tickets")


@mcp.tool()
async def get_invoices(opportunity_id: int) -> dict:
    """Invoices billed to one job, from Aspire: each invoice's number, date, this job's
    amount, and paid/open balance — plus totals (invoiced, collected, outstanding,
    paid_count). Pair with get_work_tickets for a full 'actual vs budget vs billed'
    picture of a job."""
    return await _get(f"/customer/opportunity/{opportunity_id}/invoices")


# ── Draft (no side effects) ──────────────────────────────────────────────────────

@mcp.tool()
async def draft_email(opportunity_id: int, template_key: str) -> dict:
    """Draft (render) a client email for a job from a template — e.g. template_key
    'handoff' for a welcome. Returns the merged {subject, body, to, cc, from_email,
    from_name, from_role}. This does NOT send anything. Show the draft to the user and
    let them edit it before any send."""
    return await _post(f"/construction/cx/project/{opportunity_id}/render", {"template_key": template_key})


# ── Send (gated — real outbound email) ─────────────────────────────────────────────

@mcp.tool()
async def send_email(
    opportunity_id: int,
    template_key: str,
    subject: str,
    body: str,
    to: str,
    from_email: str,
    from_name: str,
    confirmed: bool,
    from_role: str = "scheduler",
    cc: Optional[str] = None,
    sent_by: Optional[str] = None,
) -> dict:
    """SEND a client email for real (via the company mailbox) and log it. This is an
    irreversible outbound action: only call it after the user has, in this conversation,
    explicitly approved the exact recipient, subject and body — and pass confirmed=True
    to acknowledge that. Prefer draft_email first so the user can review/edit. `to` is a
    comma-separated recipient list; signature is added automatically by the server."""
    if not confirmed:
        return {"ok": False, "error": "Not sent. Set confirmed=True only after the user approves the recipient, subject and body."}
    return await _post(f"/construction/cx/project/{opportunity_id}/send", {
        "template_key": template_key, "subject": subject, "body": body, "to": to,
        "cc": cc, "from_email": from_email, "from_name": from_name,
        "from_role": from_role, "sent_by": sent_by or "CX agent (Claude)",
    })


@mcp.tool()
async def dismiss_action(opportunity_id: int, action_key: str, reason: Optional[str] = None) -> dict:
    """Mark a due action as 'not necessary' so it stops appearing in the worklist. Use
    only when the user says this action isn't needed for that job. `action_key` is the
    item's action_key from list_due_actions (e.g. 'welcome')."""
    return await _post("/construction/cx/skip", {
        "opportunity_id": opportunity_id, "action_key": action_key,
        "skipped_by": reason or "CX agent (Claude)",
    })


# ── A ready-made starting prompt ────────────────────────────────────────────────

@mcp.prompt()
def cx_review() -> str:
    """Start the morning client-experience review."""
    return (
        "You're my client-experience assistant. Call list_due_actions, then group the "
        "items by property and show me the overdue and due ones, most urgent first. For "
        "each, say which customer and which email is suggested. When I pick one, use "
        "draft_email to draft it, show it to me to review, and only send with send_email "
        "after I explicitly approve the recipient, subject and body. Never send without "
        "my go-ahead."
    )


if __name__ == "__main__":
    mcp.run()
