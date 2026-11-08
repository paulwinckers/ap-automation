"""
Access areas — what each logged-in person may see and do.

Every office endpoint belongs to one area. A user holds a set of areas (users.areas, comma-
separated); admins hold all of them. The check runs as a global dependency (area_guard) and
only applies to routes that already require a login, so the no-login field pages are untouched.

  finance     invoices, vendors, reconciliation, invoice summary, revenue, customer billing
  hr          staff records — today: safety incident reports
  customers   Customer 360, sales activity/tasks, CX emails, estimates, pipeline
  operations  construction plan & schedule, crew, daily schedule, documents, keys, safety admin
  admin       users, backups, email settings, CX settings changes, Aspire probes/debug tools

Existing staff with no areas set get DEFAULT_STAFF_AREAS until an admin sets theirs.
The Darios connector inherits this automatically: it acts as the signed-in person.
"""
from typing import Optional

from fastapi import Depends, HTTPException, Request
from fastapi.routing import APIRoute

from app.api.auth import optional_actor

AREAS = ("finance", "hr", "customers", "operations", "admin")
AREA_LABELS = {
    "finance": "Finance", "hr": "HR", "customers": "Customers & Sales",
    "operations": "Operations", "admin": "Admin",
}
DEFAULT_STAFF_AREAS = ("customers", "operations")

# Ordered (first match wins): (method or "*", route path prefix, area or None = any logged-in person).
# Matched against the ROUTE TEMPLATE (e.g. /customer/opportunity/{opp_id}/invoices), not the raw URL.
_RULES: list[tuple[str, str, Optional[str]]] = [
    # Personal — every logged-in person (My Work, own account, task threads)
    ("*", "/auth/", None),
    ("*", "/sales/due/mine", None),
    ("*", "/sales/worklist/mine", None),
    ("*", "/push/my-status", None),
    ("*", "/sales/task", None),          # /sales/task, /sales/task/{id}, /sales/tasks
    ("*", "/sales/assignees", None),
    ("*", "/sales/feed", None),           # the person's own Feed (chats they're part of)
    ("*", "/sales/{parent_type}/{parent_id}/attachment", None),
    # Admin
    ("*", "/admin/", "admin"),
    ("*", "/settings/", "admin"),
    ("PUT", "/construction/cx/settings", "admin"),
    ("*", "/spine/sync", "admin"),
    # HR
    ("*", "/safety/incidents", "hr"),
    # Finance
    ("*", "/invoices", "finance"),
    ("*", "/vendors", "finance"),
    ("*", "/reconcile", "finance"),
    ("*", "/invoice-summary", "finance"),
    ("*", "/spine/month-financials", "finance"),
    ("*", "/dashboard/sales/revenue", "finance"),
    ("*", "/customer/opportunity/{opp_id}/invoices", "finance"),
    ("*", "/email/", "finance"),          # AP inbox status / poll
    # Customers & Sales
    ("*", "/construction/cx", "customers"),
    ("*", "/customer", "customers"),
    ("*", "/sales", "customers"),
    ("*", "/spine", "customers"),
    ("*", "/estimates", "customers"),
    ("*", "/dashboard/estimating", "customers"),
    ("*", "/dashboard/activities", "customers"),
    ("*", "/dashboard/sales/pipeline", "customers"),
    # Operations
    ("*", "/construction", "operations"),
    ("*", "/checkin", "operations"),
    ("*", "/schedule", "operations"),
    ("*", "/documents", "operations"),
    ("*", "/keys", "operations"),
    ("*", "/time", "operations"),
    ("*", "/dashboard", "operations"),
    ("*", "/push/notify", "operations"),
]

_GATES = {"require_access", "current_actor", "_get_current_user", "_require_admin"}
_gated_cache: dict[int, bool] = {}


def _is_gated(route: APIRoute) -> bool:
    """True when the route already requires a login (so field/no-login routes are never touched)."""
    key = id(route)
    if key not in _gated_cache:
        names: set[str] = set()

        def walk(d):
            for sub in d.dependencies:
                names.add(getattr(sub.call, "__name__", ""))
                walk(sub)
        walk(route.dependant)
        _gated_cache[key] = bool(names & _GATES)
    return _gated_cache[key]


def area_for(method: str, path: str) -> Optional[str]:
    """The area a gated route belongs to; Aspire probe/debug tools are always admin."""
    if any(w in path for w in ("probe", "debug", "/discover", "/fields")):
        return "admin"
    for m, prefix, area in _RULES:
        if (m == "*" or m == method) and path.startswith(prefix):
            return area
    return "admin"   # an unmapped office endpoint is admin-only until it's given an area


def user_areas(user: dict) -> set[str]:
    if user.get("role") in ("admin", "service"):
        return set(AREAS)
    raw = (user.get("areas") or "").strip()
    if not raw:
        return set(DEFAULT_STAFF_AREAS)
    return {a for a in (x.strip() for x in raw.split(",")) if a in AREAS}


def parse_areas(areas: Optional[list[str]]) -> Optional[str]:
    """Validate a list from the Users page → the stored comma string (None = leave unchanged)."""
    if areas is None:
        return None
    bad = [a for a in areas if a not in AREAS]
    if bad:
        raise HTTPException(status_code=400, detail=f"Unknown area(s): {', '.join(bad)}")
    return ",".join(a for a in AREAS if a in areas)


async def area_guard(request: Request, actor: Optional[dict] = Depends(optional_actor)) -> None:
    """Global dependency: refuse a logged-in person who lacks the route's area."""
    route = request.scope.get("route")
    if not isinstance(route, APIRoute) or not _is_gated(route) or actor is None:
        return   # open route, or not authenticated (the route's own guard returns 401)
    area = area_for(request.method, route.path)
    if area and area not in user_areas(actor):
        raise HTTPException(
            status_code=403,
            detail=f"You don't have access to {AREA_LABELS[area]}. Ask an admin to add it on the Users page.",
        )
