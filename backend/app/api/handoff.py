"""
Handoff Pack Generator
======================
Fetches data from Aspire (Opportunities, Services, WorkTickets, Receipts)
and produces a professional .docx Project Handoff Package for download.

Route: GET /handoff/generate?opportunity_number=1970
Returns: application/vnd.openxmlformats-officedocument.wordprocessingml.document
"""
import io
import logging
from datetime import date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.core.config import settings
from app.services.aspire import AspireClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/handoff", tags=["handoff"])

_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)

# ── Brand colours (hex without #) ────────────────────────────────────────────
NAVY   = "1B3A5C"
LIGHT  = "EBF0F8"
WHITE  = "FFFFFF"
GREEN  = "D4EDDA"
AMBER  = "FFF3CD"
GREY   = "F8F9FA"
MID    = "DEE2E6"

# ── Aspire data helpers ───────────────────────────────────────────────────────

def _check_credentials():
    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire credentials not configured")


def _str(v: Any, fallback: str = "—") -> str:
    if v is None or v == "":
        return fallback
    return str(v)


def _fmt_date(d: Optional[str]) -> str:
    if not d:
        return "—"
    try:
        # Aspire often returns ISO with time — truncate
        return d[:10]
    except Exception:
        return d


def _fmt_money(v: Any) -> str:
    if v is None:
        return "—"
    try:
        return f"${float(v):,.2f}"
    except Exception:
        return str(v)


async def _fetch_opportunity(opp_number: int) -> Dict[str, Any]:
    """Fetch opportunity by display number (OpportunityNumber)."""
    res = await _aspire._get("Opportunities", {
        "$filter": f"OpportunityNumber eq {opp_number}",
        "$top": "1",
    })
    items = _aspire._extract_list(res)
    if items:
        return items[0]
    # Fallback: search by OpportunityID
    res2 = await _aspire._get("Opportunities", {
        "$filter": f"OpportunityID eq {opp_number}",
        "$top": "1",
    })
    items2 = _aspire._extract_list(res2)
    if items2:
        return items2[0]
    raise HTTPException(status_code=404, detail=f"Opportunity #{opp_number} not found in Aspire")


async def _fetch_services(opp_id: int) -> List[Dict[str, Any]]:
    try:
        res = await _aspire._get("OpportunityServices", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$orderby": "SortOrder asc",
            "$top": "100",
        })
        return _aspire._extract_list(res)
    except Exception as e:
        logger.warning(f"Could not fetch OpportunityServices: {e}")
        return []


async def _fetch_service_groups(opp_id: int) -> List[Dict[str, Any]]:
    try:
        res = await _aspire._get("OpportunityServiceGroups", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$top": "100",
        })
        rows = _aspire._extract_list(res)
        if rows:
            logger.info(f"OpportunityServiceGroups sample keys: {sorted(rows[0].keys())}")
        return rows
    except Exception as e:
        logger.warning(f"Could not fetch OpportunityServiceGroups: {e}")
        return []


async def _fetch_work_tickets(opp_id: int) -> List[Dict[str, Any]]:
    try:
        res = await _aspire._get("WorkTickets", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$orderby": "ScheduledStartDate asc",
            "$top": "200",
        })
        return _aspire._extract_list(res)
    except Exception as e:
        logger.warning(f"Could not fetch WorkTickets: {e}")
        return []


async def _fetch_receipts(opp_id: int) -> List[Dict[str, Any]]:
    try:
        res = await _aspire._get("Receipts", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$expand": "ReceiptItems",
            "$top": "200",
        })
        return _aspire._extract_list(res)
    except Exception as e:
        logger.warning(f"Could not fetch Receipts: {e}")
        return []


# ── DOCX builder ──────────────────────────────────────────────────────────────

def _build_docx(
    opp:            Dict[str, Any],
    services:       List[Dict[str, Any]],
    service_groups: List[Dict[str, Any]],
    tickets:        List[Dict[str, Any]],
    receipts:       List[Dict[str, Any]],
) -> bytes:
    """Build the complete handoff pack and return as bytes."""
    from docx import Document
    from docx.shared import Inches, Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    import copy

    doc = Document()

    # ── Page setup (US Letter, 1" margins) ────────────────────────────────────
    section = doc.sections[0]
    section.page_width  = Inches(8.5)
    section.page_height = Inches(11)
    section.left_margin   = Inches(1)
    section.right_margin  = Inches(1)
    section.top_margin    = Inches(1)
    section.bottom_margin = Inches(1)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _rgb(hex_str: str) -> RGBColor:
        h = hex_str.lstrip("#")
        return RGBColor(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))

    def _set_cell_bg(cell, hex_color: str):
        tc   = cell._tc
        tcPr = tc.get_or_add_tcPr()
        shd  = OxmlElement("w:shd")
        shd.set(qn("w:val"),   "clear")
        shd.set(qn("w:color"), "auto")
        shd.set(qn("w:fill"),  hex_color)
        tcPr.append(shd)

    def _set_col_width(table, col_idx: int, width_inches: float):
        """Set all cells in a column to a specific width."""
        from docx.shared import Inches as _Inches
        for row in table.rows:
            row.cells[col_idx].width = _Inches(width_inches)

    def _heading(text: str, level: int = 1):
        p = doc.add_paragraph()
        p.clear()
        run = p.add_run(text)
        run.bold = True
        run.font.color.rgb = _rgb(NAVY)
        if level == 1:
            run.font.size = Pt(16)
            p.paragraph_format.space_before = Pt(18)
            p.paragraph_format.space_after  = Pt(6)
        else:
            run.font.size = Pt(13)
            p.paragraph_format.space_before = Pt(12)
            p.paragraph_format.space_after  = Pt(4)
        # Navy bottom border
        pPr = p._p.get_or_add_pPr()
        pBdr = OxmlElement("w:pBdr")
        bottom = OxmlElement("w:bottom")
        bottom.set(qn("w:val"),   "single")
        bottom.set(qn("w:sz"),    "8" if level == 1 else "4")
        bottom.set(qn("w:space"), "1")
        bottom.set(qn("w:color"), NAVY)
        pBdr.append(bottom)
        pPr.append(pBdr)
        return p

    def _kv_table(rows: List[tuple]):
        """Two-column key-value table with navy header column."""
        t = doc.add_table(rows=len(rows), cols=2)
        t.style = "Table Grid"
        t.alignment = WD_TABLE_ALIGNMENT.LEFT
        for i, (key, val) in enumerate(rows):
            kc = t.rows[i].cells[0]
            vc = t.rows[i].cells[1]
            kc.width = Inches(2.0)
            vc.width = Inches(4.5)
            _set_cell_bg(kc, LIGHT)
            kp = kc.paragraphs[0]
            kr = kp.add_run(str(key))
            kr.bold = True
            kr.font.size = Pt(10)
            kr.font.color.rgb = _rgb(NAVY)
            vp = vc.paragraphs[0]
            vp.add_run(_str(val))
            vp.runs[0].font.size = Pt(10)
        return t

    def _section_table_header(table, headers: List[str], bg: str = NAVY):
        """Style the first row as a header row."""
        hrow = table.rows[0]
        for i, h in enumerate(headers):
            cell = hrow.cells[i]
            _set_cell_bg(cell, bg)
            p = cell.paragraphs[0]
            r = p.add_run(h)
            r.bold = True
            r.font.size = Pt(9)
            r.font.color.rgb = _rgb(WHITE)
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER

    # ── Title page ────────────────────────────────────────────────────────────
    opp_name   = _str(opp.get("OpportunityName"), "Project")
    opp_num    = _str(opp.get("OpportunityNumber"), "")
    prop_name  = _str(opp.get("PropertyName"), "")
    today_str  = date.today().strftime("%B %d, %Y")

    # Spacer
    for _ in range(5):
        doc.add_paragraph()

    title_p = doc.add_paragraph()
    title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    tr = title_p.add_run("PROJECT HANDOFF PACKAGE")
    tr.bold = True
    tr.font.size = Pt(28)
    tr.font.color.rgb = _rgb(NAVY)

    doc.add_paragraph()

    proj_p = doc.add_paragraph()
    proj_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pr = proj_p.add_run(opp_name)
    pr.font.size = Pt(20)
    pr.bold = True

    if prop_name and prop_name != "—":
        pp2 = doc.add_paragraph()
        pp2.alignment = WD_ALIGN_PARAGRAPH.CENTER
        pp2.add_run(prop_name).font.size = Pt(14)

    if opp_num and opp_num != "—":
        pnum = doc.add_paragraph()
        pnum.alignment = WD_ALIGN_PARAGRAPH.CENTER
        nr = pnum.add_run(f"Opportunity #{opp_num}")
        nr.font.size = Pt(12)
        nr.font.color.rgb = _rgb("6c757d")

    for _ in range(4):
        doc.add_paragraph()

    date_p = doc.add_paragraph()
    date_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    dr = date_p.add_run(f"Prepared: {today_str}")
    dr.font.size = Pt(11)
    dr.font.color.rgb = _rgb("6c757d")

    doc.add_page_break()

    # ── Section 1: Project Overview ───────────────────────────────────────────
    _heading("1. Project Overview")

    overview_rows = [
        ("Project Name",         opp.get("OpportunityName")),
        ("Property",             opp.get("PropertyName")),
        ("Opportunity #",        opp.get("OpportunityNumber")),
        ("Status",               opp.get("OpportunityStatusName")),
        ("Job Status",           opp.get("JobStatusName")),
        ("Division",             opp.get("DivisionName") or opp.get("BranchName")),
        ("Contract Value",       _fmt_money(opp.get("WonDollars") or opp.get("EstimatedDollars"))),
        ("Start Date",           _fmt_date(opp.get("StartDate"))),
        ("End Date",             _fmt_date(opp.get("EndDate"))),
        ("Won Date",             _fmt_date(opp.get("WonDate"))),
        ("Sales Rep",            opp.get("SalesRepContactName")),
        ("Operations Manager",   opp.get("OperationsManagerContactName")),
        ("Billing Contact",      opp.get("BillingContactName")),
        ("Project Manager",      opp.get("ProjectManagerContactName")),
    ]
    _kv_table(overview_rows)
    doc.add_paragraph()

    # ── Section 2: Scope of Work ──────────────────────────────────────────────
    doc.add_page_break()
    _heading("2. Scope of Work")

    proposal_desc = _str(opp.get("ProposalDescription") or opp.get("Description"), "")
    if proposal_desc and proposal_desc != "—":
        desc_p = doc.add_paragraph(proposal_desc)
        desc_p.runs[0].font.size = Pt(10)
        doc.add_paragraph()

    # Build a map of GroupID → services for indented child rows
    svc_by_group: Dict[Any, List[Dict[str, Any]]] = {}
    ungrouped: List[Dict[str, Any]] = []
    for svc in services:
        gid = svc.get("OpportunityServiceGroupID")
        if gid:
            svc_by_group.setdefault(gid, []).append(svc)
        else:
            ungrouped.append(svc)

    if service_groups or ungrouped:
        # Log first group's keys for field-name discovery
        if service_groups:
            logger.info(f"OpportunityServiceGroups[0] keys: {sorted(service_groups[0].keys())}")

        # ── Build flattened row list: group header + indented services ─────
        # Each entry is ("group", group_dict) or ("service", svc_dict, indent)
        table_rows: List[tuple] = []
        for grp in service_groups:
            gid = (
                grp.get("OpportunityServiceGroupID")
                or grp.get("ServiceGroupID")
                or grp.get("ID")
            )
            table_rows.append(("group", grp))
            for svc in svc_by_group.get(gid, []):
                table_rows.append(("service", svc))
        for svc in ungrouped:
            table_rows.append(("service", svc))

        if table_rows:
            sow_table = doc.add_table(rows=1 + len(table_rows), cols=3)
            sow_table.style = "Table Grid"
            _section_table_header(sow_table, ["Phase / Service Group", "Notes", "Amount"])
            # Column widths
            for row in sow_table.rows:
                row.cells[0].width = Inches(2.5)
                row.cells[1].width = Inches(3.5)
                row.cells[2].width = Inches(0.5)

            for i, entry in enumerate(table_rows, start=1):
                row = sow_table.rows[i]
                if entry[0] == "group":
                    grp = entry[1]
                    # Navy-tinted header row for each group
                    for cell in row.cells:
                        _set_cell_bg(cell, LIGHT)
                    grp_name = (
                        grp.get("GroupName")
                        or grp.get("DisplayName")
                        or grp.get("Name")
                        or grp.get("ServiceGroupName")
                        or "—"
                    )
                    grp_note = (
                        grp.get("GroupNote")
                        or grp.get("Notes")
                        or grp.get("ServiceGroupNote")
                        or grp.get("Note")
                        or grp.get("Description")
                        or ""
                    )
                    grp_amt = (
                        grp.get("ExtendedPrice")
                        or grp.get("TotalPrice")
                        or grp.get("Price")
                    )
                    name_run = row.cells[0].paragraphs[0].add_run(grp_name)
                    name_run.bold = True
                    name_run.font.size = Pt(9)
                    name_run.font.color.rgb = _rgb(NAVY)
                    note_run = row.cells[1].paragraphs[0].add_run(_str(grp_note, ""))
                    note_run.font.size = Pt(9)
                    note_run.italic = True
                    amt_run = row.cells[2].paragraphs[0].add_run(_fmt_money(grp_amt))
                    amt_run.bold = True
                    amt_run.font.size = Pt(9)
                else:
                    svc = entry[1]
                    bg = WHITE
                    for cell in row.cells:
                        _set_cell_bg(cell, bg)
                    svc_name = svc.get("DisplayName") or svc.get("ServiceNameAbrOverride") or ""
                    svc_desc = svc.get("ServiceDescription") or svc.get("OperationNotes") or ""
                    svc_amt  = svc.get("ExtendedPrice") or svc.get("PerPrice")
                    # Indent the service name slightly
                    name_p = row.cells[0].paragraphs[0]
                    name_p.paragraph_format.left_indent = Inches(0.2)
                    name_p.add_run(f"  {_str(svc_name)}").font.size = Pt(9)
                    row.cells[1].paragraphs[0].add_run(_str(svc_desc, "")).font.size = Pt(9)
                    row.cells[2].paragraphs[0].add_run(_fmt_money(svc_amt)).font.size = Pt(9)

            doc.add_paragraph()
        else:
            doc.add_paragraph("No service lines found in Aspire for this opportunity.").runs[0].font.size = Pt(10)
    else:
        doc.add_paragraph("No service lines found in Aspire for this opportunity.").runs[0].font.size = Pt(10)

    # ── Section 3: Project Schedule ────────────────────────────────────────────
    doc.add_page_break()
    _heading("3. Project Schedule")

    if tickets:
        sched_table = doc.add_table(rows=1 + len(tickets), cols=6)
        sched_table.style = "Table Grid"
        _section_table_header(sched_table, [
            "Phase / Title", "Ticket #", "Scheduled Date", "Est. Hours", "Actual Hours", "Status"
        ])
        # Column widths
        widths = [2.3, 0.7, 1.1, 0.9, 0.9, 0.6]
        for ci, w in enumerate(widths):
            for row in sched_table.rows:
                row.cells[ci].width = Inches(w)

        for i, tk in enumerate(tickets, start=1):
            row   = sched_table.rows[i]
            status = _str(tk.get("WorkTicketStatusName"), "")
            if "complete" in status.lower():
                bg = GREEN
            elif status.lower() in ("scheduled", "in progress"):
                bg = AMBER
            else:
                bg = WHITE
            for cell in row.cells:
                _set_cell_bg(cell, bg)

            cells = row.cells
            cells[0].paragraphs[0].add_run(
                _str(tk.get("WorkTicketTitle") or tk.get("WorkTicketName"))
            ).font.size = Pt(9)
            cells[1].paragraphs[0].add_run(
                _str(tk.get("WorkTicketNumber"))
            ).font.size = Pt(9)
            cells[2].paragraphs[0].add_run(
                _fmt_date(tk.get("ScheduledStartDate") or tk.get("ScheduledDate"))
            ).font.size = Pt(9)
            cells[3].paragraphs[0].add_run(
                _str(tk.get("EstimatedLaborHours"))
            ).font.size = Pt(9)
            cells[4].paragraphs[0].add_run(
                _str(tk.get("ActualLaborHours"))
            ).font.size = Pt(9)
            cells[5].paragraphs[0].add_run(status).font.size = Pt(9)

        doc.add_paragraph()
        # Legend
        leg_p = doc.add_paragraph()
        leg_p.add_run("Legend:  ").bold = True
        leg_p.add_run("  Green = Complete   ")
        leg_p.add_run("  Amber = Scheduled / In Progress").font.size = Pt(9)
        leg_p.runs[-1].font.size = Pt(9)
        for r in leg_p.runs:
            r.font.size = Pt(9)
    else:
        doc.add_paragraph("No work tickets found in Aspire for this opportunity.").runs[0].font.size = Pt(10)

    # ── Section 4: Materials & Procurement ───────────────────────────────────
    doc.add_page_break()
    _heading("4. Materials & Procurement")

    if receipts:
        for receipt in receipts:
            vendor    = _str(receipt.get("VendorName") or receipt.get("Vendor"), "Unknown Vendor")
            rcpt_date = _fmt_date(receipt.get("ReceivedDate") or receipt.get("ReceiptDate"))
            total     = _fmt_money(receipt.get("TotalAmount") or receipt.get("Total"))
            rcpt_num  = _str(receipt.get("ReceiptNumber") or receipt.get("ReceiptID"), "")

            sub_h = doc.add_paragraph()
            sr = sub_h.add_run(f"{vendor}  —  Receipt #{rcpt_num}  ({rcpt_date})  Total: {total}")
            sr.bold = True
            sr.font.size = Pt(10)
            sr.font.color.rgb = _rgb(NAVY)

            items_raw = receipt.get("ReceiptItems") or []
            if isinstance(items_raw, dict):
                items_raw = items_raw.get("value", [])

            if items_raw:
                item_table = doc.add_table(rows=1 + len(items_raw), cols=4)
                item_table.style = "Table Grid"
                _section_table_header(item_table, ["Item / Description", "Qty", "Unit Cost", "Total"])
                for j, item in enumerate(items_raw, start=1):
                    irow = item_table.rows[j]
                    bg = GREY if j % 2 == 0 else WHITE
                    for cell in irow.cells:
                        _set_cell_bg(cell, bg)
                    qty      = item.get("Quantity") or item.get("Qty") or "—"
                    unit_c   = _fmt_money(item.get("UnitCost") or item.get("UnitPrice"))
                    line_tot = _fmt_money(item.get("TotalCost") or item.get("LineTotal") or item.get("Amount"))
                    desc     = _str(item.get("Description") or item.get("ItemName") or item.get("Name"), "")
                    irow.cells[0].paragraphs[0].add_run(desc).font.size       = Pt(9)
                    irow.cells[1].paragraphs[0].add_run(str(qty)).font.size   = Pt(9)
                    irow.cells[2].paragraphs[0].add_run(unit_c).font.size     = Pt(9)
                    irow.cells[3].paragraphs[0].add_run(line_tot).font.size   = Pt(9)
            else:
                doc.add_paragraph("  (No line items available)").runs[0].font.size = Pt(9)
            doc.add_paragraph()
    else:
        doc.add_paragraph("No purchase receipts found in Aspire for this opportunity.").runs[0].font.size = Pt(10)

    # ── Section 5: Design & Plans ─────────────────────────────────────────────
    doc.add_page_break()
    _heading("5. Design & Plans")
    design_items = [
        "Site Plan / Drawing",
        "Landscape / Planting Plan",
        "Irrigation Plan",
        "Lighting Plan",
        "Grading / Drainage Plan",
        "Structural / Engineering Drawings",
        "Permits Obtained",
        "Permit Posted on Site",
        "HOA Approval",
        "Client-Approved Revisions",
    ]
    dp_table = doc.add_table(rows=1 + len(design_items), cols=3)
    dp_table.style = "Table Grid"
    _section_table_header(dp_table, ["Document / Item", "Included (Y/N)", "Notes"])
    dp_table.columns[0].width = Inches(3.0)
    dp_table.columns[1].width = Inches(1.2)
    dp_table.columns[2].width = Inches(2.3)

    for i, item in enumerate(design_items, start=1):
        row = dp_table.rows[i]
        bg = GREY if i % 2 == 0 else WHITE
        for cell in row.cells:
            _set_cell_bg(cell, bg)
        row.cells[0].paragraphs[0].add_run(item).font.size = Pt(9)
        row.cells[1].paragraphs[0].add_run("").font.size   = Pt(9)
        row.cells[2].paragraphs[0].add_run("").font.size   = Pt(9)
    doc.add_paragraph()

    # ── Section 6: Equipment Requirements ────────────────────────────────────
    _heading("6. Equipment Requirements")

    for eq_type in ["Rental Equipment", "Company-Owned Equipment"]:
        _heading(eq_type, level=2)
        eq_t = doc.add_table(rows=6, cols=4)
        eq_t.style = "Table Grid"
        _section_table_header(eq_t, ["Equipment", "Quantity", "Duration / Dates", "Notes"])
        for i in range(1, 6):
            bg = GREY if i % 2 == 0 else WHITE
            for cell in eq_t.rows[i].cells:
                _set_cell_bg(cell, bg)
                cell.paragraphs[0].add_run("").font.size = Pt(9)
        doc.add_paragraph()

    # ── Section 7: Subcontractors ─────────────────────────────────────────────
    _heading("7. Subcontractors")
    sub_t = doc.add_table(rows=6, cols=5)
    sub_t.style = "Table Grid"
    _section_table_header(sub_t, ["Subcontractor", "Trade / Scope", "Contact", "Scheduled Dates", "Contract Value"])
    for i in range(1, 6):
        bg = GREY if i % 2 == 0 else WHITE
        for cell in sub_t.rows[i].cells:
            _set_cell_bg(cell, bg)
            cell.paragraphs[0].add_run("").font.size = Pt(9)
    doc.add_paragraph()

    # ── Section 8: Notes & Special Instructions ────────────────────────────────
    _heading("8. Notes & Special Instructions")
    notes_p = doc.add_paragraph()
    notes_p.add_run("").font.size = Pt(10)
    # Box for hand-writing notes
    for _ in range(8):
        line_p = doc.add_paragraph("_" * 90)
        line_p.runs[0].font.size = Pt(8)
        line_p.runs[0].font.color.rgb = _rgb(MID)

    # ── Footer ────────────────────────────────────────────────────────────────
    from docx.oxml import OxmlElement as _OE
    from docx.oxml.ns import qn as _qn

    footer = section.footer
    fp = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
    fp.clear()
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER

    fr = fp.add_run(f"{opp_name}  |  Handoff Package  |  {today_str}  |  Page ")
    fr.font.size = Pt(8)
    fr.font.color.rgb = _rgb("6c757d")

    # Add page number field
    fldChar1 = _OE("w:fldChar"); fldChar1.set(_qn("w:fldCharType"), "begin")
    instrText = _OE("w:instrText"); instrText.text = "PAGE"; instrText.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    fldChar2 = _OE("w:fldChar"); fldChar2.set(_qn("w:fldCharType"), "end")
    page_run = fp.add_run()
    page_run._r.append(fldChar1)
    page_run._r.append(instrText)
    page_run._r.append(fldChar2)
    page_run.font.size = Pt(8)
    page_run.font.color.rgb = _rgb("6c757d")

    # ── Serialise to bytes ────────────────────────────────────────────────────
    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    return buf.read()


# ── Route ─────────────────────────────────────────────────────────────────────

@router.get("/generate")
async def generate_handoff(
    opportunity_number: int = Query(..., description="Aspire Opportunity display number"),
):
    """
    Generate and stream a .docx Handoff Package for the given opportunity.
    All Aspire data is fetched live at generation time.
    """
    _check_credentials()

    logger.info(f"Generating handoff pack for opportunity #{opportunity_number}")

    # Fetch all data in parallel
    import asyncio
    opp = await _fetch_opportunity(opportunity_number)
    opp_id = opp.get("OpportunityID")
    if not opp_id:
        raise HTTPException(status_code=404, detail="OpportunityID missing from Aspire response")

    services, service_groups, tickets, receipts = await asyncio.gather(
        _fetch_services(opp_id),
        _fetch_service_groups(opp_id),
        _fetch_work_tickets(opp_id),
        _fetch_receipts(opp_id),
    )

    logger.info(
        f"Handoff #{opportunity_number}: {len(service_groups)} groups, "
        f"{len(services)} services, {len(tickets)} tickets, {len(receipts)} receipts"
    )

    docx_bytes = _build_docx(opp, services, service_groups, tickets, receipts)

    opp_name_slug = (opp.get("OpportunityName") or f"Opportunity-{opportunity_number}") \
        .replace(" ", "_").replace("/", "-")[:60]
    filename = f"Handoff_{opp_name_slug}_{date.today().isoformat()}.docx"

    return StreamingResponse(
        io.BytesIO(docx_bytes),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
