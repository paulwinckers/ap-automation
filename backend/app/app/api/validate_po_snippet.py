"""
PO validation endpoint — used by the field crew mobile app to
look up a PO number against Aspire and return the job details.

GET /invoices/validate-po?po_number=PO-2024-801
"""

# Add this to app/api/invoices.py inside the router, after the existing endpoints.
# The full route is: GET /invoices/validate-po

from fastapi import Query

@router.get("/validate-po")
async def validate_po_endpoint(
    po_number: str = Query(..., description="PO number to validate against Aspire"),
    db: Database = Depends(get_db),
):
    """
    Validate a PO number against Aspire.
    Returns whether the PO exists, is open, and the job details.
    Used by the field crew mobile app on step 3.
    """
    # Check cache first
    cached = await db.get_cached_po(po_number)
    if cached:
        return {"valid": True, "job": cached, "cached": True}

    # Hit Aspire API
    po_data = await _aspire.get_purchase_order(po_number)

    if po_data is None:
        return {"valid": False, "error": f"PO '{po_number}' not found in Aspire"}

    status = po_data.get("OpportunityStatusName", "")
    if "cancel" in status.lower() or "closed" in status.lower():
        return {"valid": False, "error": f"PO '{po_number}' is {status} — cannot post to a closed job"}

    # Cache the result
    await db.cache_po(po_number, po_data)

    return {
        "valid": True,
        "job": po_data,
        "cached": False,
    }
