from fastapi import APIRouter

router = APIRouter()

@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/email/status")
async def email_status():
    """Return the current state of the email intake service."""
    from app.services.email_intake import email_intake
    svc = email_intake
    return {
        "running":        svc._running,
        "inbox":          getattr(__import__("app.core.config", fromlist=["settings"]).settings, "MS_AP_INBOX", None),
        "ms_configured":  bool(
            getattr(__import__("app.core.config", fromlist=["settings"]).settings, "MS_CLIENT_ID", None)
        ),
        "last_posted":    svc._posted[-5:] if svc._posted else [],
        "last_failed":    svc._failed[-5:] if svc._failed else [],
        "last_forwarded": svc._forwarded[-5:] if svc._forwarded else [],
        "last_skipped":   svc._skipped[-5:] if svc._skipped else [],
    }


@router.post("/email/trigger")
async def email_trigger():
    """Manually trigger one email poll cycle. Returns what was found and processed."""
    import logging
    from app.services.email_intake import email_intake
    from app.core.config import settings

    if not settings.MS_CLIENT_ID or not settings.MS_AP_INBOX:
        return {"error": "Microsoft Graph not configured"}

    logger = logging.getLogger("manual_trigger")

    # Snapshot counts before
    before = {
        "posted":    len(email_intake._posted),
        "failed":    len(email_intake._failed),
        "forwarded": len(email_intake._forwarded),
        "skipped":   len(email_intake._skipped),
    }

    # Peek at unread emails without processing
    try:
        emails = await email_intake.graph.get_unread_emails(settings.MS_AP_INBOX)
        subjects = [
            {"subject": e.get("subject", "(no subject)"),
             "from": e.get("from", {}).get("emailAddress", {}).get("address", "?"),
             "has_attachments": e.get("hasAttachments", False)}
            for e in emails
        ]
    except Exception as e:
        return {"error": f"Graph API error: {e}"}

    # Run a full poll
    try:
        await email_intake._process_inbox()
    except Exception as e:
        return {"emails_found": subjects, "error": f"Poll failed: {e}"}

    after = {
        "posted":    len(email_intake._posted),
        "failed":    len(email_intake._failed),
        "forwarded": len(email_intake._forwarded),
        "skipped":   len(email_intake._skipped),
    }

    return {
        "emails_found": subjects,
        "processed": {
            "posted":    after["posted"]    - before["posted"],
            "failed":    after["failed"]    - before["failed"],
            "forwarded": after["forwarded"] - before["forwarded"],
            "skipped":   after["skipped"]   - before["skipped"],
        },
        "recent_failed": email_intake._failed[-3:],
    }
