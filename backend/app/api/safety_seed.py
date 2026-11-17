"""
One-time seed for the Safety Program library. Inserts the Safety Management System
Overview (the searchable landing/index) if the table is empty. Everything else (OH&S
Manual, SWP-01…15, PHA, FHSP, Sign-Off, Policy) is loaded via the admin UI / content
phase. Idempotent: only seeds when safety_documents is empty.
"""
import logging
import re
import html as _html

logger = logging.getLogger(__name__)

_OVERVIEW_HTML = """
<p class="lead">WorkSafeBC requires every employer to identify hazards, assess risks, and
implement controls before work begins &mdash; at every level of the organization. Dario's
Landscape Services meets this obligation through a <strong>five-layer Safety Management
System (SMS)</strong>. Each layer is more specific than the one above it, and each layer
feeds the one below &mdash; a documented trail from company-wide standards down to what
happens on a specific site on a specific morning.</p>

<p>All five layers must be active and current for the system to work. A gap at any layer
&mdash; an out-of-date SWP, an FHSP that was skipped, a worker who hasn't been oriented
&mdash; weakens the entire system and exposes workers and the company to unnecessary risk.</p>

<table>
  <thead>
    <tr><th>Layer</th><th>Document suite</th><th>When</th><th>Who</th><th>Scope</th></tr>
  </thead>
  <tbody>
    <tr><td><strong>1</strong></td><td>OH&amp;S Program Manual &middot; Safety Policy &middot; PPE Policy SAF-001 &middot; Worker Sign-Off Form</td><td>Permanent &mdash; reviewed annually</td><td>Owner / GM</td><td>Company-wide</td></tr>
    <tr><td><strong>2</strong></td><td>Safe Work Procedures (SWP-01 &ndash; SWP-15)</td><td>Before each task type</td><td>Supervisor / Worker</td><td>Task-specific</td></tr>
    <tr><td><strong>3</strong></td><td>Project Hazard Assessment (PHA / PHSP)</td><td>Once per project &mdash; before Day 1</td><td>Project Manager</td><td>Project-wide</td></tr>
    <tr><td><strong>4</strong></td><td>Field Hazard &amp; Safety Plan (FHSP / FLHA)</td><td>Every shift &mdash; before tools come out</td><td>Crew Lead</td><td>Site / day-specific</td></tr>
    <tr><td><strong>5</strong></td><td>Daily Safety Talk (Toolbox Talk)</td><td>Every morning &mdash; 5&ndash;10 min</td><td>Crew Lead</td><td>Crew-level</td></tr>
  </tbody>
</table>

<h2 id="layer-1">Layer 1 &mdash; Program Foundation <small>(Company level &mdash; always active)</small></h2>
<p><strong>When:</strong> Permanent. Reviewed annually or after any WorkSafeBC order or serious incident.<br>
<strong>Who:</strong> Owner (Paul Winckers, GM) approves. PM / Ops Manager maintains. All workers trained.</p>
<ul>
  <li><strong>OH&amp;S Program Manual</strong> &mdash; 17-section written program required by WorkSafeBC OHS Regulation Part 3 (employer with 20+ workers). Covers safety policy, roles, hazard system, SWPs, orientation, equipment, inspections, incident reporting, emergency, PPE, WHMIS, heat, wildfire, winter, and continuous improvement.</li>
  <li><strong>Safety &amp; PPE Policy SAF-001</strong> &mdash; governs all workers, supervisors and subcontractors at all times. PPE requirements for 20+ task categories; heat stress, tick, wildfire, WHMIS and irrigation protocols. Safety footwear worker-supplied (CSA-approved); all other PPE company-supplied at no cost.</li>
  <li><strong>Worker Safety Sign-Off &amp; PPE Acknowledgement Form</strong> &mdash; completed at hire and re-acknowledged annually. Documents OH&amp;S program awareness, SWP training (all 15 SWPs) and PPE issuance. Filed in the employee safety file for a minimum of 2 years.</li>
</ul>

<h2 id="layer-2">Layer 2 &mdash; Safe Work Procedures <small>(Task level &mdash; before each task type)</small></h2>
<p><strong>When:</strong> Referenced before performing each task type; updated when a near-miss identifies a gap, or annually.<br>
<strong>Who:</strong> Supervisor ensures SWPs are accessible on site. Worker confirms understanding via the Sign-Off Form before performing the task.</p>
<p>Each SWP includes required PPE, a hazard table (HIGH / MEDIUM / LOW rated), step-by-step
instructions with controls, emergency actions and a sign-off block. SWP numbers are
cross-referenced in the PHA hazard table. A worker who has not been oriented on a specific
SWP may not perform that task until orientation is complete and documented.</p>
<ul>
  <li>SWP-01 &mdash; Excavation &amp; Trenching (Underground Utilities / BC 1 Call)</li>
  <li>SWP-02 &mdash; Hand Digging &amp; Potholing Around Utilities</li>
  <li>SWP-03 &mdash; Mini Excavator, Skid Steer &amp; Compact Track Loader</li>
  <li>SWP-04 &mdash; Plate Compactor, Jumping Jack &amp; Vibratory Equipment</li>
  <li>SWP-05 &mdash; Retaining Wall &amp; Structural Block Installation</li>
  <li>SWP-06 &mdash; Concrete / Paver Cutting (Silica Dust Control)</li>
  <li>SWP-07 &mdash; Landscape Lighting (Electrical Safety)</li>
  <li>SWP-08 &mdash; Irrigation System Installation &amp; Repair</li>
  <li>SWP-09 &mdash; Manual Handling, Ergonomics &amp; Lifting</li>
  <li>SWP-10 &mdash; Commercial Lawn Mowing (Rider &amp; Walk-Behind)</li>
  <li>SWP-11 &mdash; String Trimmer &amp; Brushcutter</li>
  <li>SWP-12 &mdash; Chainsaw Operation</li>
  <li>SWP-13 &mdash; Traffic Control &amp; Roadside Work (TCP)</li>
  <li>SWP-14 &mdash; Wildfire Smoke &amp; Air Quality (AQHI Protocol)</li>
  <li>SWP-15 &mdash; Heat Stress &amp; Hot Weather Work</li>
</ul>

<h2 id="layer-3">Layer 3 &mdash; Project Hazard Assessment <small>(Project level &mdash; before mobilization)</small></h2>
<p><strong>When:</strong> Once per project, before the first crew member arrives. Updated if scope changes materially.<br>
<strong>Who:</strong> Project Manager completes; Crew Lead and crew review on Day 1 before any work begins.</p>
<p>Covers project scope and phases, a site-conditions assessment from a pre-start visit,
permits and regulatory requirements (BC 1 Call, road use, TCP, operator certifications),
Prime Contractor designation (OHS Reg. ss.118&ndash;119), the project-level hazard
assessment with risk ratings and applicable SWP numbers, emergency preparedness, and
action items to resolve before mobilization. Retained for the life of the project and a
minimum of 2 years after completion.</p>

<h2 id="layer-4">Layer 4 &mdash; Field Hazard &amp; Safety Plan <small>(Daily site level &mdash; every shift)</small></h2>
<p><strong>When:</strong> Every shift, every site, before any tools come out. Updated mid-shift if conditions change.<br>
<strong>Who:</strong> Crew Lead completes; every worker on site reads and signs before starting. PM reviews the completed batch weekly.</p>
<p>Covers today's scope of work, hazard identification for today's conditions (AQHI, ground,
traffic, equipment, weather), PPE confirmation, pre-start checks (BC 1 Call still valid,
work zone set up, equipment pre-start done), the applicable SWPs for today's tasks, and
crew sign-off. <strong>The FHSP does not replace the PHA &mdash; it applies the PHA to the
day in front of you.</strong> A wind shift bringing smoke, overnight rain that saturates the
soil, or a new mid-project hazard can change the risk picture from yesterday; the FHSP is
where that change is captured.</p>

<h2 id="layer-5">Layer 5 &mdash; Daily Safety Talk <small>(Crew level &mdash; every morning)</small></h2>
<p><strong>When:</strong> Every morning, alongside or right after the FHSP. 5&ndash;10 minutes.<br>
<strong>Who:</strong> Crew Lead delivers; all workers participate. Record kept with the day's FHSP.</p>
<p>Covers current AQHI and weather (checked at env.gov.bc.ca during smoke season), today's
hazards and controls from the FHSP, the key steps and hazard points of the applicable
SWP(s), any new or changed conditions, and a rotating safety topic (tick awareness,
hydration, equipment blind spots, silica controls, stop-work authority). <strong>Stop-work
authority:</strong> any worker may &mdash; and must &mdash; stop work if an uncontrolled
hazard appears. There are no exceptions.</p>

<h2 id="how-they-connect">How the five layers connect</h2>
<p>Layer 1 sets the rules. Layer 2 defines how specific tasks must be done. Layer 3 applies
both to a specific project before mobilization. Layer 4 applies the project plan to each
specific day and site. Layer 5 brings it to life in a two-way crew conversation before work
begins.</p>
<ul>
  <li>A hazard identified in the <strong>PHA</strong> generates an SWP reference &rarr; that SWP is confirmed accessible in the <strong>FHSP</strong> &rarr; its key steps are reviewed in the <strong>toolbox talk</strong> &rarr; the worker was trained on it and signed off in <strong>Layer 1</strong>. That is the full closed loop.</li>
  <li>Worker does not know an SWP &rarr; the Sign-Off Form shows the training gap &rarr; retrain before the task begins.</li>
  <li>New hazard appears mid-project &rarr; FHSP updated; if significant, PHA updated; the relevant SWP is reviewed.</li>
  <li>Incident occurs &rarr; investigated against Layers 1&ndash;5; the gap is corrected at the layer where it exists &rarr; the program is updated.</li>
</ul>

<p class="footer-note">Dario's Landscape Services Ltd. &middot; Safety Management System Overview &middot;
Approved: Paul Winckers, GM &middot; Governed by WorkSafeBC OHS Regulation Part 3.</p>
"""


def _plain(html_str: str) -> str:
    s = re.sub(r"<\s*(br|/p|/div|/li|/h[1-6])\s*>", " \n", html_str, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = _html.unescape(s)
    s = re.sub(r"[ \t]+", " ", s)
    return re.sub(r"\n{2,}", "\n", s).strip()


async def seed_safety_program_if_empty(db):
    """Seed the Overview if the safety_documents table has no rows."""
    rows = await db._q("SELECT COUNT(*) AS n FROM safety_documents", [])
    if rows and rows[0]["n"]:
        return
    await db._x(
        """INSERT INTO safety_documents
           (slug, title, category, layer, code, summary, html, plain_text, version,
            status, field_visible, sort_order, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 1, 0, 'seed')""",
        ["safety-management-overview", "Safety Management System — Overview", "overview", 0, None,
         "How our five-layer safety program works — from company policy to daily field practice.",
         _OVERVIEW_HTML, _plain(_OVERVIEW_HTML), "Sep 2026"])
    logger.info("Seeded Safety Program: Overview")
