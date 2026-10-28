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

Two ways to run it (see README.md):
  - LOCAL (stdio, default): Claude Code / Desktop on one PC, identity from DARIOS_ACT_AS.
  - HOSTED (MCP_TRANSPORT=http): a Claude Team custom connector on Railway. Each person
    signs in with their Darios portal login (oauth_provider.py) and acts as themselves.

Config via env vars:
  DARIOS_API       base URL (default: the production backend)
  DARIOS_API_KEY   the backend SERVICE_API_KEY, sent as X-API-Key
  DARIOS_ACT_AS    local mode only: the rep this connector acts as
  MCP_TRANSPORT    'http' to host it; MCP_PUBLIC_URL (its https URL), MCP_SIGNING_KEY
                   (random secret, 32+ chars) and PORT are then required
"""
import os
from typing import Optional

import httpx
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.fastmcp import FastMCP

API = os.environ.get("DARIOS_API", "https://ap-automation-production.up.railway.app").rstrip("/")
KEY = os.environ.get("DARIOS_API_KEY", "")
# Identity this connector acts as (a rep's email or user id). On Claude Team this is set per rep
# so "my tasks / my worklist" resolve to that person; with the service key it is sent as the
# X-Act-As-User header. Leave unset for the generic service principal.
ACT_AS = os.environ.get("DARIOS_ACT_AS", "").strip()
TIMEOUT = 120.0
HOSTED = os.environ.get("MCP_TRANSPORT", "stdio").lower() == "http"

if HOSTED:
    from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions, RevocationOptions
    from oauth_provider import SCOPE, DariosOAuthProvider

    PUBLIC_URL = os.environ["MCP_PUBLIC_URL"].rstrip("/")
    _oauth = DariosOAuthProvider(os.environ["MCP_SIGNING_KEY"], API, PUBLIC_URL)
    mcp = FastMCP(
        "Darios CX",
        host="0.0.0.0", port=int(os.environ.get("PORT", "8000")),
        stateless_http=True,
        auth_server_provider=_oauth,
        auth=AuthSettings(
            issuer_url=PUBLIC_URL,
            resource_server_url=f"{PUBLIC_URL}/mcp",
            validate_token_resource=False,
            client_registration_options=ClientRegistrationOptions(
                enabled=True, valid_scopes=[SCOPE], default_scopes=[SCOPE]),
            revocation_options=RevocationOptions(enabled=True),
        ),
    )
    mcp.custom_route("/login", methods=["GET", "POST"])(_oauth.login_page)
else:
    mcp = FastMCP("Darios CX")


def _headers() -> dict:
    h: dict = {}
    if KEY:
        h["X-API-Key"] = KEY
    if HOSTED:
        # Hosted: ALWAYS the signed-in person — never fall back to a shared identity.
        tok = get_access_token()
        if not tok or not tok.subject:
            raise RuntimeError("Not signed in to Darios")
        h["X-Act-As-User"] = tok.subject
    elif ACT_AS:
        h["X-Act-As-User"] = ACT_AS
    return h


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


async def _patch(path: str, body: dict):
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.patch(f"{API}{path}", json=body, headers=_headers())
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
async def get_month_financials(month: Optional[str] = None) -> dict:
    """All-divisions revenue for a month: expected (budgeted) vs earned-to-date, total AND
    by division (maintenance / construction / snow / irrigation). `month` = 'YYYY-MM'
    (default current month). Rolls up every work ticket, so it answers 'what's our expected
    earned revenue this month' and 'how is maintenance vs construction tracking'. Earned is
    partial mid-month (rises as tickets complete)."""
    return await _get("/spine/month-financials" + (f"?month={month}" if month else ""))


@mcp.tool()
async def get_time_efficiency(start: Optional[str] = None, end: Optional[str] = None,
                              approved: bool = False) -> dict:
    """Billable hours by department from Aspire crew labor (WorkTicketTimes). Department = each
    entry's SERVICE TYPE — the same division Aspire's own time-entry grid shows per line (it follows
    the service, so irrigation on a maintenance property lands in Irrigation & Lighting, and the
    monthly drive/overhead ticket lands in 'Indirect/Overhead', which is non-billable). `start`/`end`
    are 'YYYY-MM-DD' inclusive; omit both for last week (Sun–Sat, matching Aspire's week). Counts ALL
    time entries by default (matching an Aspire grid export); pass approved=True for approved-only.
    Returns by_department, direct vs indirect hours, OT, approved_hours, and billable_pct (direct ÷
    total). Answers 'what were our billable hours by department last week'."""
    params = {}
    if start: params["start"] = start
    if end:   params["end"] = end
    if approved: params["approved"] = "true"
    return await _get("/time/efficiency", params or None)


@mcp.tool()
async def get_service_hours(property: Optional[str] = None, property_id: Optional[int] = None,
                            year: Optional[int] = None, start: Optional[str] = None,
                            end: Optional[str] = None, service_contains: str = "") -> dict:
    """Actual-vs-ESTIMATED labor hours (and revenue) for a property's service work tickets, optionally
    narrowed to one service and a time period. Use for 'how are we tracking time vs estimate on
    <property>'s maintenance contract', 'how many hours did the <property> <service> take [in <year>]',
    'what did we bill for <property> <service>', or totals of any recurring service at a site.
    `property` is a name to resolve (e.g. 'Mission Flats') — if it matches more than one property the
    tool returns the candidates (resolved=False) so you can re-call with `property_id`. Period: pass
    `year` (e.g. 2025) OR `start`/`end` ('YYYY-MM-DD'); omit both for all years. `service_contains` is a
    case-insensitive substring of the service name (e.g. 'blowout', 'irrigation', 'maintenance'); leave
    blank for every service. Returns tickets_matched; total_hours_est, total_hours_act, total_variance
    (actual − estimate; positive = OVER) and variance_pct; total_revenue; a by_service breakdown (each
    with est/act/variance); and the ticket list (each ticket has hours_est, hours_act, variance).
    hours_act is Aspire's booked actual hours; wtt_hours re-sums the time entries as a cross-check."""
    params: dict = {}
    if property:          params["property_query"]   = property
    if property_id:       params["property_id"]      = property_id
    if year:              params["year"]             = year
    if start:             params["start"]            = start
    if end:               params["end"]              = end
    if service_contains:  params["service_contains"] = service_contains
    return await _get("/time/service-hours", params or None)


@mcp.tool()
async def get_maintenance_summary(year: Optional[int] = None, start: Optional[str] = None,
                                  end: Optional[str] = None, service_contains: str = "maintenance",
                                  division_contains: Optional[str] = None,
                                  sort: str = "variance_pct", limit: int = 200) -> dict:
    """Book-wide actual-vs-estimated summary across EVERY maintenance contract — answers 'how are our
    maintenance contracts tracking on time vs estimate' and 'which contracts are most over'. Aggregates
    work-ticket HoursEst/HoursAct by opportunity (the contract) for the period and ranks them. Period:
    `year` (default current year) OR `start`/`end` ('YYYY-MM-DD'). `service_contains` defines the
    contract work (default 'maintenance'; change it to summarize another recurring service book-wide).
    `division_contains` optionally limits to e.g. 'commercial' or 'residential'. `sort` = 'variance_pct'
    (default, most over estimate first), 'variance' (most over by hours), or 'hours_act'. Returns a
    totals block (hours_est, hours_act, variance, variance_pct, revenue) and a ranked `contracts` list,
    each with opportunity, property, division, tickets, hours_est, hours_act, variance, variance_pct,
    revenue. For a single site's detail use get_service_hours instead."""
    params: dict = {}
    if year:              params["year"]              = year
    if start:             params["start"]             = start
    if end:               params["end"]               = end
    if service_contains:  params["service_contains"]  = service_contains
    if division_contains: params["division_contains"] = division_contains
    if sort:              params["sort"]              = sort
    if limit:             params["limit"]             = limit
    return await _get("/time/maintenance-summary", params or None)


@mcp.tool()
async def search_ticket_notes(query: str = "", service_contains: str = "",
                              property: Optional[str] = None, property_id: Optional[int] = None,
                              year: Optional[int] = None, start: Optional[str] = None,
                              end: Optional[str] = None, include_empty_notes: bool = False,
                              limit: int = 300) -> dict:
    """Search/review Aspire work tickets (any service/division) and their Notes — for loose ends,
    follow-ups, or anything crews recorded. `query` is case-insensitive free text matched in the note
    body. Narrow with `service_contains` (service name, e.g. 'blowout', 'irrigation', 'maintenance'),
    a `property` name (or `property_id`; an ambiguous name returns candidates with resolved=False),
    and a period (`year`, or `start`/`end` 'YYYY-MM-DD'). Must pass at least one filter so the search
    stays bounded. By default only tickets that HAVE a note are returned — pass include_empty_notes=
    True for a FULL review of every matching ticket (commercial site tickets often have no note, so
    use this to avoid missing them). Returns tickets_returned, tickets_with_notes, a by_division
    breakdown, and a list of {work_ticket, property, service, division, scheduled, completed, status,
    hours_act, has_note, notes}. Examples: review ALL irrigation blowouts this year across both
    divisions → service_contains='blowout', year=2026, include_empty_notes=True; find tickets
    mentioning a broken part → query='broken'."""
    params: dict = {}
    if query:               params["query"]               = query
    if service_contains:    params["service_contains"]    = service_contains
    if property:            params["property_query"]      = property
    if property_id:         params["property_id"]         = property_id
    if year:                params["year"]                = year
    if start:               params["start"]               = start
    if end:                 params["end"]                 = end
    if include_empty_notes: params["include_empty_notes"] = "true"
    if limit:               params["limit"]               = limit
    return await _get("/time/ticket-notes", params or None)


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


# ── Sales activity tools ─────────────────────────────────────────────────────────

@mcp.tool()
async def log_sales_activity(customer_key: str, body: str, type: str = "note",
                             subject: Optional[str] = None, opportunity_id: Optional[int] = None,
                             next_action_date: Optional[str] = None, next_action_note: Optional[str] = None,
                             created_by: Optional[str] = None, direction: Optional[str] = None,
                             occurred_at: Optional[str] = None) -> dict:
    """Log a sales activity for a customer — a conversation note, call, meeting, email, or
    SITE VISIT. `customer_key` is 'company:{id}' | 'contact:{id}' (from search_customers;
    works for a brand-new lead too). `type`: note|call|meeting|email|site_visit. Set
    next_action_date (YYYY-MM-DD) + next_action_note to schedule a followup. `created_by` =
    the salesperson's name. Returns the created activity (note its id to attach photos or
    spawn tasks). Photos/videos are added from the field app, not here.
    For an EMAIL: type='email', subject = the email's subject, body = who it was from/to plus
    the message text (trim long quoted threads/signatures), direction = 'in' (customer → us) or
    'out' (us → customer), occurred_at = when it was sent/received (ISO 8601, from the email
    itself — not now)."""
    return await _post("/sales/activity", {
        "customer_key": customer_key, "type": type, "subject": subject, "body": body,
        "opportunity_id": opportunity_id, "next_action_date": next_action_date,
        "next_action_note": next_action_note, "created_by": created_by,
        "direction": direction, "occurred_at": occurred_at})


@mcp.tool()
async def list_sales_activities(customer_key: str) -> dict:
    """A customer's sales timeline (notes/calls/visits/emails), newest first, with attachments."""
    return await _get(f"/sales/activities?customer_key={customer_key}")


@mcp.tool()
async def create_sales_task(title: str, customer_key: Optional[str] = None, assignee: Optional[str] = None,
                            due_date: Optional[str] = None, detail: Optional[str] = None,
                            activity_id: Optional[int] = None, opportunity_id: Optional[int] = None,
                            created_by: Optional[str] = None) -> dict:
    """Create a task for a coworker (e.g. from a site visit: 'have Dustin verify the grade').
    `assignee` = who does it, `due_date` YYYY-MM-DD, `activity_id` links it to the visit that
    spawned it. Tasks are living records — append progress with add_task_update and attach
    photos from the app. Returns the task (note its id)."""
    return await _post("/sales/task", {
        "title": title, "customer_key": customer_key, "assignee": assignee, "due_date": due_date,
        "detail": detail, "activity_id": activity_id, "opportunity_id": opportunity_id, "created_by": created_by})


@mcp.tool()
async def add_task_update(task_id: int, body: str, author: Optional[str] = None) -> dict:
    """Append a progress note to a task's thread (the living log)."""
    return await _post(f"/sales/task/{task_id}/update", {"body": body, "author": author})


@mcp.tool()
async def update_task(task_id: int, status: Optional[str] = None, assignee: Optional[str] = None,
                      due_date: Optional[str] = None, title: Optional[str] = None,
                      detail: Optional[str] = None) -> dict:
    """Edit a task — reassign, change the due date, or set status to 'done' (or 'cancelled').
    Marking done stamps done_at and drops it off the due worklist."""
    patch = {k: v for k, v in {"status": status, "assignee": assignee, "due_date": due_date,
                               "title": title, "detail": detail}.items() if v is not None}
    return await _patch(f"/sales/task/{task_id}", patch)


@mcp.tool()
async def complete_followup(activity_id: int) -> dict:
    """Mark an activity's followup done so it drops off the due list."""
    return await _patch(f"/sales/activity/{activity_id}", {"next_action_done": True})


@mcp.tool()
async def whoami() -> dict:
    """Return the person this connector is acting as (id, email, name, role). Use to confirm
    identity for 'my tasks / my worklist'. If it returns the 'service' principal or errors, the
    connector has no rep identity set (DARIOS_ACT_AS) — say so rather than guessing a person."""
    return await _get("/auth/me")


@mcp.tool()
async def get_my_worklist() -> dict:
    """THE signed-in rep's personal morning worklist — their open sales tasks, pending followups,
    due client-comms they own, and assigned job-prep items, merged and bucketed (overdue / today /
    soon). This is 'what's on my plate'. Scoped to the connector's identity (DARIOS_ACT_AS / the
    signed-in user); if no identity is set it returns 400 — call whoami to check."""
    return await _get("/sales/worklist/mine")


@mcp.tool()
async def get_my_due_items() -> dict:
    """The signed-in rep's own due items — their open tasks + pending followups matched by their
    user id and name, each with a due bucket. Narrower than get_my_worklist (sales items only).
    Scoped to the connector's identity; 400 if no identity is set (see whoami)."""
    return await _get("/sales/due/mine")


@mcp.tool()
async def list_due_items(assignee: Optional[str] = None, due_before: Optional[str] = None) -> dict:
    """What's due on the sales side: open tasks + pending followups, merged and sorted by
    date. Filter by `assignee` (a coworker, or a rep's own followups) and `due_before`
    (YYYY-MM-DD, e.g. today for 'due now'). Use this to prompt 'here's what's due'. For the
    CURRENT rep's own list, prefer get_my_worklist / get_my_due_items."""
    qs = []
    if assignee:
        qs.append(f"assignee={assignee}")
    if due_before:
        qs.append(f"due_before={due_before}")
    return await _get("/sales/due" + ("?" + "&".join(qs) if qs else ""))


@mcp.tool()
async def create_sales_opportunity(opportunity_name: str, opportunity_type: str, confirmed: bool,
                                   property_id: Optional[int] = None, division_id: Optional[int] = None,
                                   sales_rep_id: Optional[int] = None, start_date: Optional[str] = None,
                                   activity_id: Optional[int] = None) -> dict:
    """Create a real Aspire Opportunity from a site visit (the sales → construction handoff).
    IRREVERSIBLE — Aspire can't delete opportunities via API — so only call with confirmed=true
    AFTER the user approves the name, type, property and division. `opportunity_type` is an
    Aspire value (confirm the valid options with the user on first use). `activity_id` links
    the new opportunity back to the visit. Estimate lines are built in Aspire by the estimator;
    this creates the opportunity header only."""
    return await _post("/sales/opportunity", {
        "opportunity_name": opportunity_name, "opportunity_type": opportunity_type, "confirmed": confirmed,
        "property_id": property_id, "division_id": division_id, "sales_rep_id": sales_rep_id,
        "start_date": start_date, "activity_id": activity_id})


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


@mcp.prompt(title="Save email to Darios")
def save_email(which_email: str = "") -> str:
    """Save an email (from your Outlook) to a customer's history in Darios."""
    target = f" The email: {which_email}." if which_email else ""
    return (
        "Save an email to a customer's history in Darios." + target + " Steps:\n"
        "1. Find the email in my Outlook (if I haven't said which, ask, or show my 5 most recent "
        "customer emails to pick from). If it's a thread, use the specific message I mean.\n"
        "2. Find the customer with search_customers (try the sender's company, then the person's "
        "name, then the property/address mentioned). If more than one match, or none, ask me — "
        "never guess the account.\n"
        "3. Show me what you'll save in one short block: customer, subject, in/out, date, and a "
        "1-2 line summary. Wait for my OK.\n"
        "4. Save it with log_sales_activity: type='email', subject, body = from/to + the message "
        "text (drop long quoted history and signatures), direction 'in' if the customer sent it or "
        "'out' if we did, occurred_at = the email's own sent/received time. Link opportunity_id only "
        "if the email is clearly about one job.\n"
        "5. Then ask whether to set a follow-up (next_action_date + next_action_note) or create a "
        "task for someone."
    )


if HOSTED:
    @mcp.custom_route("/health", methods=["GET"])
    async def health(request):
        from starlette.responses import JSONResponse
        return JSONResponse({"ok": True})


if __name__ == "__main__":
    mcp.run(transport="streamable-http" if HOSTED else "stdio")
