"""
Starter load for the remaining Safety Program documents, transcribed faithfully from the
source files on the owner's Desktop\\Safety set:
  * OH&S Program Manual (v1.0)              — Layer 1, category 'manual'
  * Worker Safety Sign-Off & PPE Form (v2.2)— Layer 1, category 'signoff'
  * Project Hazard Assessment (PHA, v3)     — Layer 3, category 'pha'
  * Field Health & Safety Plan (FHSP)       — Layer 4, category 'fhsp'

The PHA/FHSP/Sign-Off are standing *forms*: their fixed content (hazards, pre-set controls,
SWP mappings, PPE, checklists) is reproduced as searchable reference; the fill-in fields are
described rather than rendered as inputs, since the field viewer is read-only.

Insert-if-missing by slug, never updated here — once in the table the admin page owns each
document, so staff edits / new versions survive deploys.
"""
import logging

from app.api.safety_seed import _plain

logger = logging.getLogger(__name__)


def _esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _ul(items: list[str]) -> str:
    return "<ul>" + "".join(f"<li>{i}</li>" for i in items) + "</ul>"


def _table(cols: list[str], rows: list[list[str]]) -> str:
    out = ["<table><thead><tr>" + "".join(f"<th>{_esc(c)}</th>" for c in cols) + "</tr></thead><tbody>"]
    for r in rows:
        out.append("<tr>" + "".join(f"<td>{_esc(c)}</td>" for c in r) + "</tr>")
    out.append("</tbody></table>")
    return "".join(out)


def _grouped(cols: list[str], groups: list[tuple]) -> str:
    n = len(cols)
    out = ["<table><thead><tr>" + "".join(f"<th>{_esc(c)}</th>" for c in cols) + "</tr></thead><tbody>"]
    for title, rows in groups:
        out.append(f'<tr><th colspan="{n}">{_esc(title)}</th></tr>')
        for r in rows:
            out.append("<tr>" + "".join(f"<td>{_esc(c)}</td>" for c in r) + "</tr>")
    out.append("</tbody></table>")
    return "".join(out)


def _form_note(text: str) -> str:
    return f'<p class="lead">{text}</p>'


# ══════════════════════════════════════════════════════════════════════════════════
#  OH&S PROGRAM MANUAL
# ══════════════════════════════════════════════════════════════════════════════════
def _manual_html() -> str:
    h: list[str] = []
    h.append('<p class="lead">This manual is the written Occupational Health &amp; Safety Program for '
             "Dario's Landscape Services Ltd., as required under the Workers Compensation Act and BC OHS "
             "Regulation Part 3. It applies to all employees, subcontractors, and visitors at all Dario's "
             "work sites. <strong>Controlled document</strong> &mdash; reviewed annually or when "
             "regulations change; uncontrolled when printed.</p>")
    h.append("<p>Dario's Landscape Services Ltd. &middot; 3300 Sexsmith Road, Kelowna, BC V1X 7S5 &middot; "
             "Governing authority: WorkSafeBC &mdash; BC OHS Regulation &middot; Version 1.0.</p>")

    h.append("<h2>1. Health &amp; Safety Policy Statement</h2>")
    h.append("<p>Dario's Landscape Services Ltd. is committed to providing a safe and healthy workplace for "
             "all employees, subcontractors, clients, and members of the public who may be affected by our "
             "operations. We believe that all workplace injuries and occupational illnesses are preventable, "
             "and we will take every reasonable precaution to protect the health and safety of our workers.</p>")
    h.append("<p>Dario's Landscape Services will:</p>")
    h.append(_ul([
        "Comply with the Workers Compensation Act, the BC OHS Regulation, and all applicable health and "
        "safety legislation.",
        "Identify, assess, and control workplace hazards before work begins and on an ongoing basis.",
        "Provide workers with the training, information, instruction, and supervision necessary to work safely.",
        "Maintain a Joint Health &amp; Safety Committee (JHSC) that meets regularly to review and improve "
        "safety performance.",
        "Investigate all incidents, near misses, and unsafe conditions to identify root causes and prevent "
        "recurrence.",
        "Involve workers in the development, implementation, and review of this Health &amp; Safety Program.",
        "Hold all levels of management and supervision accountable for health and safety performance.",
        "Review and update this program annually and whenever there is a change in work processes or legislation.",
    ]))
    h.append("<p>This policy applies to all work performed by Dario's Landscape Services Ltd., including "
             "landscape maintenance, landscape construction, irrigation installation, and all related "
             "activities at any job site. Approved by Paul Winckers, CPA, Owner, and the Health &amp; Safety "
             "Officer (Matt Gaucher). This policy statement is to be posted at all Dario's field offices and "
             "crew vehicles, and reviewed with all workers during orientation.</p>")

    h.append("<h2>2. Company Profile &amp; Program Scope</h2>")
    h.append(_table(["Field", "Detail"], [
        ["Company name", "Dario's Landscape Services Ltd."],
        ["Operating address", "3300 Sexsmith Road, Kelowna, BC V1X 7S5"],
        ["Number of employees", "Approximately 45"],
        ["WorkSafeBC account #", "355232"],
        ["NAICS code", "561730 – Landscaping Services"],
        ["Operations", "Landscape Maintenance, Landscape Construction, Irrigation, Commercial Property Maintenance"],
    ]))
    h.append("<h3>2.2 Scope of this program</h3>")
    h.append("<p>This OH&amp;S Program applies to all work activities performed by Dario's, including but not "
             "limited to:</p>")
    h.append(_ul([
        "Landscape maintenance (mowing, trimming, pruning, seasonal clean-up)",
        "Landscape construction (excavation, retaining walls, hardscape/paver installation, grading, compaction)",
        "Irrigation system installation, repair, and winterization",
        "Landscape lighting installation",
        "Planting, sodding, and hydroseeding",
        "Commercial property maintenance at client sites",
        "Work performed by temporary workers and subcontractors engaged by Dario's",
    ]))
    h.append("<h3>2.3 Applicable legislation</h3>")
    h.append(_ul([
        "BC Workers Compensation Act (RSBC 2019, c. 1)",
        "BC OHS Regulation (WorkSafeBC)",
        "WorkSafeBC Policies and Guidelines",
        "BC Environmental Management Act (where applicable)",
        "Motor Vehicle Act (for vehicle operations)",
        "Any applicable municipal or site-specific safety requirements",
    ]))

    h.append("<h2>3. Roles and Responsibilities</h2>")
    h.append("<p>Health and safety is everyone's responsibility. The following outlines specific duties at "
             "each level of the organization.</p>")
    h.append("<h3>3.1 Owner / Senior Management</h3>")
    h.append(_ul([
        "Provide and maintain a safe and healthy work environment.",
        "Ensure the OH&amp;S Program is implemented, maintained, and reviewed annually.",
        "Allocate resources (time, money, equipment) necessary for health and safety.",
        "Establish health and safety goals and hold supervisors accountable for safety performance.",
        "Ensure a Joint Health &amp; Safety Committee is established and supported.",
        "Review JHSC recommendations within 21 days and respond in writing.",
        "Ensure all workers are trained, competent, and properly supervised.",
        "Lead by example and visibly demonstrate commitment to safety.",
    ]))
    h.append("<h3>3.2 Supervisors / Crew Leads</h3>")
    h.append(_ul([
        "Ensure workers under their direction have the knowledge and skills to work safely.",
        "Conduct and document pre-shift safety briefings (toolbox talks / morning crew meetings).",
        "Complete the Field Health &amp; Safety Plan (FHSP) or Field Level Hazard Assessment (FLHA) before "
        "each shift.",
        "Inspect the work site for hazards before and during each shift.",
        "Ensure all required PPE is available, worn, and in good condition.",
        "Enforce all safe work procedures &mdash; stop unsafe work immediately.",
        "Investigate and report all incidents, near misses, and unsafe conditions.",
        "Ensure BC 1 Call is confirmed (minimum 3 business days) before any excavation or trenching.",
        "Ensure equipment pre-start inspections are completed and documented before use.",
        "Ensure no worker is impaired by alcohol, drugs, or fatigue.",
        "Know the location of first aid supplies and emergency procedures.",
        "Maintain required records (FHSP, FLHA, inspection logs, training records).",
    ]))
    h.append("<h3>3.3 Workers</h3>")
    h.append(_ul([
        "Work in compliance with this OH&amp;S Program, safe work procedures, and all WorkSafeBC regulations.",
        "Use all required PPE correctly and report damaged or missing equipment immediately.",
        "Report all hazards, near misses, injuries, and unsafe conditions to their supervisor.",
        "Participate in safety orientations, training, and toolbox talks.",
        "Refuse unsafe work as provided under the Workers Compensation Act.",
        "Not perform any work while impaired by alcohol, drugs, or fatigue.",
        "Cooperate with incident investigations.",
        "Not use personal electronic devices (earbuds, headphones, cell phones) while operating equipment or tools.",
    ]))
    h.append("<h3>3.4 Health &amp; Safety Officer</h3>")
    h.append(_ul([
        "Coordinate the development, implementation, and ongoing review of the OH&amp;S Program.",
        "Serve as the management co-chair of the Joint Health &amp; Safety Committee.",
        "Maintain all health and safety records and ensure retention requirements are met.",
        "Track incidents, investigate trends, and report to senior management.",
        "Ensure WorkSafeBC submissions (incident reports, WCB clearance, etc.) are made on time.",
        "Coordinate external safety audits and WorkSafeBC inspection responses.",
        "Stay current on changes to the OHS Regulation and update the program accordingly.",
        "Maintain the company's safety records system and ensure all crew documentation is current and accessible.",
    ]))
    h.append("<h3>3.5 Subcontractors</h3>")
    h.append(_ul([
        "Comply with Dario's OH&amp;S Program, all client site safety requirements, and the BC OHS Regulation.",
        "Provide their own OH&amp;S program or safe work procedures upon request.",
        "Maintain a valid WorkSafeBC Clearance Letter and provide it prior to commencing work.",
        "Report all incidents, near misses, and hazards to the Dario's supervisor on site.",
        "Attend site safety orientations and morning crew meetings when working alongside Dario's crew.",
    ]))

    h.append("<h2>4. Joint Health &amp; Safety Committee (JHSC)</h2>")
    h.append("<p>As an employer with more than 20 workers, Dario's Landscape Services Ltd. is required under "
             "Section 125 of the BC Workers Compensation Act to establish and maintain a Joint Health &amp; "
             "Safety Committee.</p>")
    h.append("<h3>4.2 Composition</h3>")
    h.append(_table(["Role", "How determined"], [
        ["Worker Representatives (minimum 2)", "Elected or selected by workers — at least half of committee members must be worker representatives"],
        ["Employer Representatives (minimum 2)", "Appointed by senior management — may not include the owner or senior officers"],
        ["Management Co-Chair", "H&S Officer (or Senior Manager) — appointed by employer"],
        ["Worker Co-Chair", "Elected by worker representatives on the committee"],
    ]))
    h.append("<h3>4.3 Meetings</h3>")
    h.append(_ul([
        "The JHSC meets at least once per month during the operating season (April&ndash;November) and at "
        "least once per quarter during the off-season.",
        "Meetings are chaired alternately by the management and worker co-chairs.",
        "Minutes are recorded and posted at the workplace within 7 days of the meeting.",
        "Minutes are retained for at least 3 years.",
        "Quorum requires at least one worker representative and one employer representative.",
    ]))
    h.append("<h3>4.4 JHSC functions</h3>")
    h.append(_ul([
        "Identify situations that may be unhealthy or unsafe and advise on corrective action.",
        "Conduct workplace inspections at least once per month.",
        "Participate in incident investigations.",
        "Make recommendations to the employer on improving the OH&amp;S Program.",
        "Review incident statistics and trends.",
        "Participate in the annual review of the OH&amp;S Program.",
        "Ensure this manual and safety policies are current and accessible to all workers.",
    ]))
    h.append("<p>Current JHSC members are posted on the safety bulletin board at the main office; the list is "
             "updated whenever committee membership changes.</p>")

    h.append("<h2>5. Hazard Identification &amp; Control System</h2>")
    h.append("<p>Dario's uses a four-layer system to identify and control hazards at every level of the "
             "organization. Each layer addresses a different scope and frequency of hazard assessment.</p>")
    h.append(_table(["Layer", "Document / Activity", "Purpose &amp; Frequency"], [
        ["1", "Safety Policy", "Sets the overall commitment and accountability framework. Reviewed annually."],
        ["2", "Project Hazard Assessment (PHA) / Pre-Project Hazard & Safety Plan (PHSP)", "Completed before mobilization on any new or complex project. Identifies project-level hazards and required controls."],
        ["3", "Field Health & Safety Plan (FHSP) / Field Level Hazard Assessment (FLHA)", "Completed at the start of every shift at every work site. Identifies daily site-specific hazards and confirms controls are in place."],
        ["4", "Daily Safety Talk / Toolbox Talk", "Morning crew briefing covering that shift's FHSP, hazards, tasks, PPE, and any crew concerns."],
    ]))
    h.append("<h3>5.2 Hazard control hierarchy</h3>")
    h.append("<p>When a hazard is identified, controls must be applied in the following order of priority "
             "(OHS Regulation Section 5.54):</p>")
    h.append("<ol>"
             "<li><strong>Elimination</strong> — remove the hazard entirely (e.g., reschedule work to avoid "
             "adverse conditions).</li>"
             "<li><strong>Substitution</strong> — replace with a less hazardous alternative (e.g., use "
             "battery-powered tools to reduce exhaust).</li>"
             "<li><strong>Engineering controls</strong> — physically isolate workers from the hazard (e.g., "
             "guarding, trench shoring, GFCI protection).</li>"
             "<li><strong>Administrative controls</strong> — change how the work is done (e.g., work rotation, "
             "BC 1 Call, traffic control plan).</li>"
             "<li><strong>PPE</strong> — last line of defence; workers use personal protective equipment after "
             "higher-order controls are applied.</li>"
             "</ol>")
    h.append("<h3>5.3 High-risk work requiring additional controls</h3>")
    h.append(_ul([
        "Excavation or trenching &gt; 1.2 m &mdash; trench protection plan required (shoring or sloped walls).",
        "Work near underground utilities &mdash; BC 1 Call minimum 3 business days in advance; locate ticket # on FHSP.",
        "Work near overhead power lines &mdash; minimum 3 m clearance; no exceptions without written utility owner approval.",
        "Roadside or traffic-exposed work &mdash; Traffic Control Plan (TCP) required per WorkSafeBC and BCTS standards.",
        "Work at height &mdash; fall protection plan required; zero-tolerance policy.",
        "Concrete and paver cutting / grinding &mdash; wet cutting or N95 respirator required; silica controls mandatory.",
        "Work in wildfire smoke &mdash; AQHI check required before each shift; N95 respirators available on all vehicles.",
        "Heat stress &mdash; Humidex monitoring; rest and hydration requirements per SAF-001.",
    ]))
    h.append("<h3>5.4 Forms and records</h3>")
    h.append(_ul([
        "<strong>FLHA</strong> — Field Level Hazard Assessment: blank daily form for all operations.",
        "<strong>FHSP</strong> — Field Health &amp; Safety Plan: site-specific pre-loaded form (Landmark "
        "Towers maintenance; Construction Division).",
        "<strong>PHA</strong> — Project Hazard Assessment: completed before mobilization on new or complex "
        "construction projects.",
        "All completed forms must be retained for a minimum of 2 years.",
    ]))

    h.append("<h2>6. Safe Work Procedures</h2>")
    h.append("<p>Safe Work Procedures (SWPs) provide step-by-step instructions for performing specific "
             "high-hazard tasks safely. They supplement the hazard assessment forms and are used for worker "
             "training and as reference documents on site. (The full SWPs are published separately in this "
             "Safety Program &mdash; see Layer 2.)</p>")
    h.append(_table(["SWP #", "Task / Procedure", "Applicable Roles"], [
        ["SWP-01", "Excavation and Trenching", "Construction crew, Supervisor"],
        ["SWP-02", "Underground Utility Locating (BC 1 Call)", "All field crew, Supervisor"],
        ["SWP-03", "Mini Excavator / Skid Steer Operation", "Certified equipment operators, Supervisor"],
        ["SWP-04", "Plate Compactor Operation", "Construction crew"],
        ["SWP-05", "Retaining Wall Construction", "Construction crew, Supervisor"],
        ["SWP-06", "Concrete / Paver Cutting and Grinding (Silica)", "Construction crew"],
        ["SWP-07", "Irrigation Wiring — Controller and Solenoids", "Irrigation technicians"],
        ["SWP-08", "Landscape Lighting — Low-Voltage Wiring", "Irrigation/Lighting technicians"],
        ["SWP-09", "Manual Handling — Pavers, Boulders, Trees", "All field crew"],
        ["SWP-10", "Mowing — Commercial Rider and Walk-Behind", "Maintenance crew"],
        ["SWP-11", "String Trimmer / Brushcutter Operation", "All field crew"],
        ["SWP-12", "Chainsaw / Hand Saw Operation", "Qualified workers only"],
        ["SWP-13", "Roadside / Traffic-Exposed Work", "All crew working near traffic"],
        ["SWP-14", "Work in Wildfire Smoke (AQHI Protocol)", "All field crew"],
        ["SWP-15", "Heat Stress Prevention", "All field crew"],
    ]))
    h.append("<p>SWPs are developed or updated whenever a new high-hazard task is introduced, following an "
             "incident involving that task, or when regulations change. Workers who perform the task are "
             "consulted during development. All SWPs are reviewed annually and signed/dated by the H&amp;S Officer.</p>")

    h.append("<h2>7. Worker Orientation &amp; Training</h2>")
    h.append("<p>All new workers, returning seasonal workers, and workers newly assigned to a different work "
             "type must complete a company orientation before starting work. Orientation is conducted by the "
             "supervisor or H&amp;S Officer and covers:</p>")
    h.append(_ul([
        "This OH&amp;S Manual and the company Health &amp; Safety Policy.",
        "Worker rights and responsibilities under the Workers Compensation Act (right to refuse unsafe work, "
        "right to participate in safety, right to know about hazards).",
        "The four-layer safety system: Policy &rarr; PHA/PHSP &rarr; FHSP/FLHA &rarr; Daily Safety Talk.",
        "How to complete an FHSP or FLHA form.",
        "Emergency procedures including reporting injuries, emergency contacts, and muster points.",
        "PPE requirements for their role.",
        "Incident and near-miss reporting procedure.",
        "The company safety records system — where forms are stored and how to submit completed documents.",
        "Substance use and impairment policy.",
        "Workplace violence and harassment policy.",
    ]))
    h.append("<p>Orientation completion is documented on the New Worker Orientation Checklist and signed by "
             "the worker and supervisor. When working at a client's construction site (e.g., Stober Group), "
             "workers may also be required to complete the client's own site orientation before entering the "
             "work zone.</p>")
    h.append("<h3>7.3 Required training by role</h3>")
    h.append(_table(["Training Requirement", "Applicable Roles", "Notes"], [
        ["OFA Level 1 (Occupational First Aid)", "All field supervisors / crew leads", "WorkSafeBC OFA Level 1 minimum; Level 3 for 50+ workers at remote sites"],
        ["WHMIS 2015", "All workers", "Annual review required"],
        ["Fall Protection", "Any worker working at height", "WorkSafeBC-recognized training"],
        ["Equipment Operator — Mini Excavator / Skid Steer", "Equipment operators only", "Must be certified/trained; certifications on file"],
        ["Traffic Control Person (TCP)", "Roadside work crew", "BCTS or equivalent — required for roadside operations"],
        ["Silica Awareness", "Concrete/paver cutting crew", "Includes wet-cut method and N95 use"],
        ["Pesticide Applicator Certificate", "Pesticide applicators only", "Issued by BC Ministries — if applicable"],
        ["Chainsaw Safety", "Chainsaw operators", "WCB/industry-recognized course"],
    ]))
    h.append("<p>All training completions are documented (worker name, date, provider, certificate number) and "
             "kept in the personnel file and the company safety records system. Supervisors confirm training "
             "records are current for their crew before mobilizing to any work site.</p>")

    h.append("<h2>8. Equipment Inspection &amp; Maintenance</h2>")
    h.append("<h3>8.1 Daily pre-start inspections</h3>")
    h.append(_ul([
        "All powered equipment (mini excavator, skid steer, plate compactor, trucks, trailers, ride-on "
        "mowers) must be inspected by the operator before use each day.",
        "The Equipment Pre-Start Checklist (Section 5 of the FHSP or standalone form) must be completed.",
        "Any defect must be reported to the supervisor immediately. Defective equipment is tagged OUT OF "
        "SERVICE and must not be used until repaired.",
        "The pre-start inspection record is retained with the day's FHSP.",
    ]))
    h.append("<h3>8.2 Periodic maintenance</h3>")
    h.append(_ul([
        "All equipment is maintained according to the manufacturer's recommended service intervals.",
        "Maintenance records are kept in the equipment log file.",
        "ROPS (Roll Over Protective Structures) and operator restraints are inspected at each pre-start and "
        "must be functional before any equipment is used.",
        "Equipment used on slopes must not exceed the manufacturer's maximum rated slope.",
    ]))
    h.append("<h3>8.3 Hand tools and power tools</h3>")
    h.append(_ul([
        "Hand tools and power tools are inspected before use. Damaged tools (cracked handles, worn cords, "
        "missing guards) are removed from service.",
        "All power tools used outdoors must be GFCI-protected.",
        "Cords are inspected for damage before each use.",
    ]))
    h.append("<h3>8.4 Vehicles</h3>")
    h.append(_ul([
        "Company vehicles are inspected per the Vehicle Pre-Start Checklist before each use.",
        "All drivers must hold a valid BC driver's licence appropriate to the vehicle class.",
        "No worker may operate a company vehicle while impaired.",
    ]))

    h.append("<h2>9. Personal Protective Equipment (PPE)</h2>")
    h.append("<p>The following PPE is required for all Dario's field workers on any work site. Client sites may "
             "impose additional requirements.</p>")
    h.append(_table(["PPE Item", "Requirement", "Standard"], [
        ["CSA steel/composite-toe safety boots", "All workers, all sites, at all times", "CSA Z195"],
        ["Safety glasses", "All power tool, equipment, and cutting/grinding operations", "CSA Z94.3"],
        ["Work gloves", "General work — cut-resistant for hardscape/retaining wall", "Appropriate to task"],
        ["Hearing protection", "All powered equipment operation — NO personal earbuds or headphones", "CSA Z94.2"],
        ["Hard hat", "Overhead hazard, equipment operation, construction sites", "CSA Z94.1, Class E"],
        ["Hi-Visibility vest (Class 2)", "Roadside, parking lot, and public-area work", "CSA Z96"],
        ["N95 respirator", "Concrete/paver cutting, sawcutting; AQHI ≥ 7 (wildfire smoke)", "NIOSH N95"],
        ["Face shield", "Grinding, wire brushing, pressure washing", "CSA Z94.3"],
        ["Anti-vibration gloves", "Extended compaction, hammer drill, powered trenching", "EN 10819"],
        ["Sunscreen SPF 30+ / sun hat", "Extended outdoor work — strongly recommended", "Best practice"],
        ["First aid kit / trauma kit", "In crew vehicle — accessible at all times on site", "WorkSafeBC minimum"],
    ]))
    h.append("<p>Dario's provides all required PPE at no cost to the worker (safety footwear is worker-supplied "
             "per SAF-001 s.6). Workers inspect PPE before each use; damaged, expired, or missing PPE is "
             "reported and replaced immediately.</p>")

    h.append("<h2>10. Incident Reporting &amp; Investigation</h2>")
    h.append(_table(["Term", "Definition"], [
        ["Near Miss", "An event that could have resulted in injury, illness, or property damage, but did not."],
        ["First Aid Incident", "An injury or illness that requires only first aid treatment on site — no medical attention required."],
        ["Medical Aid Incident", "An injury or illness that requires treatment by a physician or other health professional."],
        ["Lost-Time Injury (LTI)", "An injury or illness that prevents the worker from returning to work on the next scheduled shift."],
        ["Serious Incident / Fatality", "Death, serious injury, loss of consciousness, or structural collapse. Requires immediate WorkSafeBC notification (1-888-621-7233)."],
    ]))
    h.append("<h3>10.2 Reporting procedure</h3>")
    h.append("<p><strong>ALL incidents, near misses, and unsafe conditions must be reported, regardless of "
             "severity.</strong></p>")
    h.append(_ul([
        "Worker reports to supervisor immediately.",
        "Supervisor ensures first aid is provided as needed and secures the scene.",
        "Supervisor notifies H&amp;S Officer (or Owner) as soon as possible.",
        "Serious incident or fatality: supervisor calls WorkSafeBC immediately at 1-888-621-7233.",
        "Incident form is completed and submitted to the H&amp;S Officer within 24 hours.",
        "All incidents are recorded in the company safety records system.",
    ]))
    h.append("<h3>10.3 WorkSafeBC reporting obligations</h3>")
    h.append(_ul([
        "Serious injuries and fatalities must be reported to WorkSafeBC immediately by phone (1-888-621-7233).",
        "Form 7 (Employer's Report of Injury or Occupational Disease) must be submitted within 3 calendar "
        "days of a worker seeking medical treatment.",
        "The injured worker must be directed to file Form 6A (Worker's Report) with WorkSafeBC.",
    ]))
    h.append("<h3>10.4 Incident investigation</h3>")
    h.append(_ul([
        "All incidents and near misses are investigated to identify root causes and prevent recurrence.",
        "The supervisor conducts the initial investigation. The JHSC reviews all investigations at the next "
        "scheduled meeting.",
        "The investigation determines: what happened, why it happened (root cause), and what corrective "
        "action is required.",
        "Corrective actions are assigned to a responsible person with a completion date and followed up at "
        "the next JHSC meeting.",
        "Investigation reports are retained for a minimum of 2 years.",
    ]))

    h.append("<h2>11. Emergency Response</h2>")
    h.append(_table(["Emergency Contact", "Number"], [
        ["Emergency (Fire / Police / Ambulance)", "911"],
        ["WorkSafeBC Serious Incident / Prevention Line", "1-888-621-7233"],
        ["Kelowna General Hospital", "2268 Pandosy St — (250) 862-4000"],
        ["Interior Health Occupational Health", "(250) 862-4234"],
        ["BC Poison Control Centre", "1-800-567-8911"],
        ["BC Hydro (Power Line Emergency)", "1-888-769-3766"],
        ["FortisBC (Gas Emergency)", "1-800-663-9911"],
        ["BC 1 Call (Utility Locates)", "1-800-474-6886"],
    ]))
    h.append("<h3>11.2 Worker injury response</h3>")
    h.append(_ul([
        "Call 911 for any serious or life-threatening injury.",
        "Provide first aid within the limits of the responder's training.",
        "Do not move a seriously injured worker unless there is immediate life-threatening danger.",
        "Call WorkSafeBC immediately for any serious injury or fatality (1-888-621-7233).",
        "Preserve the scene — do not disturb until WorkSafeBC gives clearance.",
        "Notify the supervisor and H&amp;S Officer / Owner.",
    ]))
    h.append("<h3>11.3 Utility strike</h3>")
    h.append(_ul([
        "Stop work. Evacuate the immediate area.",
        "<strong>GAS STRIKE:</strong> Call 911 and FortisBC immediately. Do not operate electrical equipment. "
        "Evacuate a minimum 300 m radius.",
        "<strong>ELECTRICAL STRIKE:</strong> Call 911 and BC Hydro. Do not approach or touch any equipment or "
        "wires. Stay at least 10 m away.",
        "Do not resume work in the area until the utility owner has cleared the site.",
        "Report to WorkSafeBC — utility strikes are reportable serious incidents.",
    ]))
    h.append("<h3>11.4 Fire</h3>")
    h.append(_ul([
        "Evacuate all workers to the muster point.",
        "Call 911.",
        "Do not attempt to fight a fire unless you have been trained and the fire is small and contained.",
        "Ensure all workers are accounted for at the muster point.",
    ]))
    h.append("<h3>11.5 Wildfire smoke (AQHI protocol)</h3>")
    h.append(_ul([
        "Check AQHI at env.gov.bc.ca before each shift and record on the FHSP.",
        "AQHI 4&ndash;6 (Moderate): N95 respirators available and offered. Increase rest breaks.",
        "AQHI 7&ndash;10 (High): N95 respirators required for all outdoor workers. Supervisor evaluates "
        "whether work should continue.",
        "AQHI &gt; 10 (Very High): Consult H&amp;S Officer. Suspend outdoor work or relocate to enclosed "
        "environment.",
    ]))
    h.append("<p>The muster point for each job site is identified and communicated in the morning crew meeting. "
             "Workers proceed to the muster point immediately upon any site evacuation; the supervisor takes "
             "attendance and confirms all workers are accounted for.</p>")

    h.append("<h2>12. Workplace Inspections</h2>")
    h.append("<p>Regular inspections identify hazards before they cause injuries. They are separate from daily "
             "FHSP/FLHA assessments and provide a systematic review of the work environment, equipment, and "
             "work practices.</p>")
    h.append(_table(["Inspection Type", "Frequency", "Conducted By"], [
        ["JHSC Workplace Inspection", "Monthly (at least)", "JHSC — one worker rep + one employer rep"],
        ["Vehicle and Equipment Inspection", "Daily (pre-start)", "Operator / Supervisor"],
        ["Field Site Walk-Through", "Each shift (as part of FHSP/FLHA)", "Supervisor"],
    ]))
    h.append("<p>Findings are documented on the Workplace Inspection Report and classified as Immediate Action "
             "(stop work / fix now), Priority (fix within 24 hours), or Scheduled (fix within 1 week). "
             "Corrective actions are assigned with a responsible person and deadline; open items are reviewed "
             "at the next JHSC meeting. Reports are retained for a minimum of 2 years.</p>")

    h.append("<h2>13. Health &amp; Safety Records Management</h2>")
    h.append(_table(["Record Type", "Retention Period", "Storage Location"], [
        ["FHSP / FLHA (completed daily forms)", "Minimum 2 years", "Office file + safety records system"],
        ["PHA / PHSP (project hazard assessments)", "Minimum 2 years after project completion", "Office file + safety records system"],
        ["Incident / Near-Miss Investigation Reports", "Minimum 2 years; WorkSafeBC reportable: 10 years", "Office file + safety records system"],
        ["JHSC Meeting Minutes", "Minimum 3 years", "Office file, posted at workplace"],
        ["Workplace Inspection Reports", "Minimum 2 years", "Office file + safety records system"],
        ["Worker Training Records", "Duration of employment + 2 years", "Worker personnel file + safety records system"],
        ["WorkSafeBC Form 7 (Employer Injury Reports)", "Minimum 10 years", "Office file"],
        ["Equipment Maintenance Records", "Life of equipment", "Equipment log file"],
        ["Worker Orientation Checklists", "Duration of employment + 2 years", "Worker personnel file"],
        ["WorkSafeBC Clearance Letters", "Until new one issued", "Project file"],
    ]))
    h.append("<p>All records are maintained in the company safety records system and are available for "
             "WorkSafeBC audit on request.</p>")

    h.append("<h2>14. Return to Work Program</h2>")
    h.append("<p>Dario's is committed to supporting injured workers in returning to safe, meaningful work as "
             "soon as medically appropriate. Early and safe return to work benefits recovery and reduces the "
             "duration and cost of WorkSafeBC claims.</p>")
    h.append(_ul([
        "When a worker cannot return to full pre-injury duties, Dario's will identify appropriate modified "
        "duties within the worker's functional limitations.",
        "Modified duties must be approved by the treating healthcare provider and will not compromise the "
        "health and safety of the injured worker or any other worker.",
        "The H&amp;S Officer or Owner meets with the injured worker as soon as possible after the injury to "
        "discuss return-to-work options.",
        "Dario's cooperates with WorkSafeBC, files Form 7 within 3 calendar days of the worker seeking medical "
        "attention, and participates in WorkSafeBC return-to-work planning as required.",
    ]))

    h.append("<h2>15. Substance Use Policy</h2>")
    h.append("<p>Dario's is committed to a workplace free from the adverse effects of alcohol, drugs, and "
             "other impairing substances. The safety of all workers, clients, and the public depends on "
             "workers being fully alert and in complete control of their faculties at all times.</p>")
    h.append(_ul([
        "No worker shall report to work, or remain at work, while impaired by alcohol, cannabis, prescription "
        "drugs, or any other substance.",
        "The use or possession of alcohol or illegal drugs at any Dario's worksite or company vehicle is "
        "strictly prohibited.",
        "Prescription medications that may impair performance must be disclosed to the supervisor before "
        "performing safety-sensitive tasks; the supervisor determines whether a modified duty assignment is "
        "appropriate.",
        "Workers are not permitted to operate any company vehicle, equipment, or power tool while impaired.",
        "A worker reasonably believed to be impaired will be removed from the worksite immediately and not "
        "permitted to drive a company vehicle. Violations may result in discipline up to and including "
        "termination. Workers are encouraged to seek assistance through the BC Employee Assistance Program (EAP).",
    ]))

    h.append("<h2>16. Workplace Violence &amp; Harassment Prevention</h2>")
    h.append("<p>Dario's is committed to a respectful, inclusive workplace free from violence and harassment. "
             "This commitment applies to all employees, supervisors, managers, clients, contractors, and any "
             "person at a Dario's work site.</p>")
    h.append(_ul([
        "<strong>Workplace Violence:</strong> any attempt or act to physically injure or threaten a worker, "
        "or to destroy property.",
        "<strong>Workplace Harassment</strong> (WorkSafeBC definition): any inappropriate conduct by a person "
        "that the person knew or reasonably ought to have known would cause a worker to be humiliated or "
        "intimidated.",
        "<strong>Discriminatory Harassment:</strong> includes harassment based on any ground protected under "
        "the BC Human Rights Code (race, gender, sexual orientation, religion, etc.).",
    ]))
    h.append(_ul([
        "Workers who experience or witness violence or harassment must report it to their supervisor or the "
        "H&amp;S Officer immediately; reports may also be made directly to the Owner if the supervisor is "
        "involved.",
        "All reports are taken seriously, investigated promptly, and treated with as much confidentiality as "
        "possible. Workers who report in good faith are protected from retaliation.",
        "WorkSafeBC may be involved if required under the OHS Regulation.",
    ]))

    h.append("<h2>17. Program Review &amp; Continuous Improvement</h2>")
    h.append(_ul([
        "The OH&amp;S Program is reviewed annually, at a minimum, by the Owner, H&amp;S Officer, and the JHSC.",
        "The review considers changes in legislation, incident trends, JHSC recommendations, audit findings, "
        "and changes in work processes or equipment. Results are documented and revisions made before the "
        "start of the next operating season.",
    ]))
    h.append("<p>The program (or relevant sections) will be reviewed immediately following: any serious "
             "incident or fatality; any WorkSafeBC order, citation, or penalty; introduction of a new work "
             "process, equipment type, or chemical/substance; a significant change in workforce composition "
             "or work locations; or a change in the BC OHS Regulation relevant to Dario's operations.</p>")
    h.append("<p>Workers are encouraged to raise safety concerns, suggest improvements, and participate in the "
             "development and review of this program at any time &mdash; through their supervisor, the JHSC "
             "worker representative, or directly with the H&amp;S Officer. There will be no reprisal for "
             "raising safety concerns in good faith.</p>")

    h.append('<p class="footer-note">Dario\'s Landscape Services Ltd. &middot; OH&amp;S Program Manual v1.0 '
             '&middot; Approved: Paul Winckers, Owner &middot; Governed by WorkSafeBC OHS Regulation Part 3. '
             'Controlled document &mdash; reviewed annually or when regulations change.</p>')
    return "\n".join(h)


# ══════════════════════════════════════════════════════════════════════════════════
#  WORKER SAFETY SIGN-OFF & PPE ACKNOWLEDGEMENT FORM
# ══════════════════════════════════════════════════════════════════════════════════
def _signoff_html() -> str:
    h: list[str] = []
    h.append(_form_note(
        "This is the Worker Safety Sign-Off &amp; PPE Acknowledgement Form (SAF-001 v2.2). It is completed at "
        "hire and re-acknowledged each year, with a supervisor present. The content below is the standing form "
        "&mdash; workers and supervisors initial each item on the signed copy, which is retained in the "
        "employee safety file for a minimum of 2 years."))

    h.append("<h2>2. OH&amp;S Programme Awareness Declaration</h2>")
    h.append("<p>By initialling each item, the worker confirms they have been briefed on and understand each "
             "element of the OH&amp;S Programme. A supervisor must be present during orientation and also "
             "initials each line.</p>")
    h.append(_table(["#", "Element"], [
        ["1", "Company Safety Policy — I have read the Company Safety Policy Statement and understand that safety is a condition of employment at Dario's Landscape Services."],
        ["2", "OH&S Programme Manual — I have been briefed on the OH&S Programme Manual and know where it is accessible at the office, shop, and on site."],
        ["3", "Right to Refuse Unsafe Work — I understand my right to refuse unsafe work under WorkSafeBC OHS Regulation s.3.12, and that I will not be disciplined for a good-faith refusal."],
        ["4", "Hazard Identification & Reporting — I know how to identify a hazard, how to report it to my crew lead or supervisor, and that I can document hazards on the daily FHSP form."],
        ["5", "Incident & Near-Miss Reporting — I understand the incident reporting procedure and that all near-misses, first-aid incidents, and injuries must be reported to my supervisor immediately, no matter how minor."],
        ["6", "Field Hazard & Safety Plan (FHSP/FLHA) — I have been shown how to read and participate in the morning FHSP/FLHA completion, and I understand I must initial the form before work begins each day."],
        ["7", "Project Hazard Assessment (PHA) — I understand that a PHA is completed before each project begins and that I will be briefed on its contents by my crew lead on Day 1 of each new project."],
        ["8", "WHMIS & Chemical Safety — I understand my obligations under WHMIS 2015, know how to find Safety Data Sheets (SDS) for products I use, and know I must not use a chemical before reviewing its SDS."],
        ["9", "Joint Health & Safety Committee (JHSC) — I am aware that Dario's operates a JHSC, know who the worker representative is, and understand I can raise safety concerns through the JHSC at any time."],
        ["10", "Safe Work Procedures (SWPs) — I have received or reviewed the SWP Manual and understand that the applicable SWP must be followed for every task I perform."],
    ]))

    h.append("<h2>3. Safe Work Procedure (SWP) Acknowledgement</h2>")
    h.append("<p>The SWPs applicable to the worker's role are checked. For each, the worker confirms they have "
             "been trained on the procedure and the supervisor confirms training was delivered. Workers may not "
             "perform a task until the corresponding SWP has been reviewed.</p>")
    h.append(_table(["SWP #", "Safe Work Procedure Title"], [
        ["SWP-01", "Excavation & Trenching — Underground Utilities (BC 1 Call)"],
        ["SWP-02", "Hand Digging & Potholing Around Utilities"],
        ["SWP-03", "Mini Excavator, Skid Steer & Compact Track Loader"],
        ["SWP-04", "Plate Compactor, Jumping Jack & Vibratory Equipment"],
        ["SWP-05", "Retaining Wall & Structural Block Installation"],
        ["SWP-06", "Concrete / Paver Cutting — Silica Dust Control"],
        ["SWP-07", "Landscape Lighting — Electrical Safety"],
        ["SWP-08", "Irrigation System Installation & Repair"],
        ["SWP-09", "Manual Handling, Ergonomics & Lifting"],
        ["SWP-10", "Commercial Lawn Mowing — Rider & Walk-Behind"],
        ["SWP-11", "String Trimmer & Brushcutter"],
        ["SWP-12", "Chainsaw Operation"],
        ["SWP-13", "Traffic Control & Roadside Work (TCP)"],
        ["SWP-14", "Wildfire Smoke & Air Quality — AQHI Protocol"],
        ["SWP-15", "Heat Stress & Hot Weather Work"],
    ]))

    h.append("<h2>4. PPE Issuance — Company-Supplied Items</h2>")
    h.append("<p>The items below are company-supplied at no cost to the worker (SAF-001 s.3). Each issued item "
             "is checked and initialled by worker and supervisor. <strong>CSA safety footwear is "
             "worker-supplied</strong> (SAF-001 s.6): Construction division &mdash; steel or composite toe, "
             "minimum 6&quot; height; Maintenance &amp; Irrigation &mdash; CSA-approved composite toe "
             "acceptable. Supervisor confirms footwear compliance before the first day on site; a worker may "
             "not begin work with non-compliant footwear.</p>")
    h.append(_table(["PPE Item (company-supplied)", "Standard"], [
        ["Safety glasses", "CSA Z94.3"],
        ["Work gloves — general", "Task-appropriate"],
        ["Work gloves — cut-resistant (hardscape/retaining wall)", "Task-appropriate"],
        ["Hearing protection — earmuffs and/or foam earplugs", "CSA Z94.2"],
        ["Hard hat", "CSA Z94.1 Class E"],
        ["Hi-Visibility vest — Class 2", "CSA Z96"],
        ["N95 respirators (stock of 5)", "NIOSH N95"],
        ["Face shield", "CSA Z94.3"],
        ["Anti-vibration gloves", "EN 10819"],
        ["Sunscreen SPF 30+ (shop/vehicle stock)", "Company-provided"],
    ]))

    h.append("<h2>5. Worker Declaration</h2>")
    h.append("<p>By signing, the worker confirms that:</p>")
    h.append(_ul([
        "I have received an orientation covering all items in Sections 2, 3, and 4 of this form.",
        "I have had the opportunity to ask questions and receive answers to my satisfaction.",
        "I understand my responsibilities under the Dario's OH&amp;S Programme and the Workers Compensation "
        "Act (BC).",
        "I commit to following all safe work procedures, using the required PPE for each task, and reporting "
        "hazards and incidents immediately.",
        "I understand that failure to comply with these requirements may result in disciplinary action up to "
        "and including termination.",
    ]))
    h.append("<p>Signed by the worker and the supervisor who delivered the orientation. OH&amp;S Programme "
             "authority: Paul Winckers, General Manager &mdash; approved July 26, 2026.</p>")

    h.append("<h2>6. Annual Re-Acknowledgement</h2>")
    h.append("<p>Completed each year, or whenever the policy or SWPs are updated. By signing each year, the "
             "worker confirms the safety programme has been reviewed with them, any updated SWPs or policy "
             "changes have been communicated and understood, PPE remains in serviceable condition, and their "
             "commitment to safe work procedures continues.</p>")

    h.append('<p class="footer-note">Dario\'s Landscape Services Ltd. &middot; Worker Safety Sign-Off &amp; PPE '
             'Acknowledgement Form &middot; SAF-001 v2.2 &middot; Retain in the employee safety file for a '
             'minimum of 2 years after employment ends. Governed by the OH&amp;S Programme Manual &amp; Safety '
             '&amp; PPE Policy SAF-001 v2.2 &middot; WorkSafeBC OHS Regulation Part 3.</p>')
    return "\n".join(h)


# ══════════════════════════════════════════════════════════════════════════════════
#  PROJECT HAZARD ASSESSMENT (PHA)
# ══════════════════════════════════════════════════════════════════════════════════
def _pha_html() -> str:
    h: list[str] = []
    h.append(_form_note(
        "This is the Project Hazard Assessment (PHA) template. It is completed <strong>before mobilization</strong> "
        "on any new or complex project and reviewed with the full crew on Day 1 before any work begins. The "
        "content below is the standing template &mdash; the project-specific details, risk ratings, controls and "
        "sign-offs are filled in per project and retained for a minimum of 2 years."))

    h.append("<h2>Project Information &amp; Prime Contractor Role</h2>")
    h.append("<p>Records the project name/description, work order #, site address and jurisdiction, client and "
             "contacts, project manager, crew lead, crew size, and planned start/end dates. Dario's role is "
             "identified as <strong>Prime Contractor</strong> or Trade Contractor.</p>")
    h.append("<p><strong>If Prime Contractor:</strong> (1) Post &lsquo;Prime Contractor: Dario's Landscape "
             "Services Ltd.&rsquo; at the site entrance before Day 1. (2) The Dario's supervisor holds full "
             "worksite safety authority and coordinates all employers and workers on site. (3) WorkSafeBC OHS "
             "Regulation ss. 118&ndash;119 apply &mdash; Dario's is responsible for the OH&amp;S program for "
             "the entire worksite. (4) Ensure all other employers on site have their own OH&amp;S programs and "
             "have been briefed on this PHA.</p>")

    h.append("<h2>Project Scope &amp; Phases</h2>")
    h.append("<p>All work types included in the project are checked, with estimated sequence/timing:</p>")
    h.append(_ul([
        "Site demolition / clearing", "Excavation / bulk earthworks", "Grading & fine grading",
        "Soil amendment / import / export", "Underground irrigation rough-in",
        "Irrigation head installation & wiring", "Irrigation controller & start-up",
        "Retaining wall construction", "Hardscape / paver / concrete flatwork", "Concrete cutting or grinding",
        "Drainage / catch basin installation", "Sodding / seeding", "Planting (trees, shrubs, perennials)",
        "Mulching / top dressing", "Fencing / garden structures", "Landscape lighting installation",
        "Roadside / boulevard work", "Work in occupied / public space", "Final cleanup & deficiency walkthrough",
    ]))

    h.append("<h2>Site Conditions Assessment</h2>")
    h.append("<p>Completed during a pre-start site visit; each condition gets an assessment and any action "
             "required before mobilization:</p>")
    h.append(_ul([
        "Ground conditions (soil type, stability, drainage, slope)",
        "Existing vegetation / trees to protect or remove",
        "Overhead hazards (power lines, tree limbs, structures)",
        "Underground utilities — BC 1 Call ticket planned? Private utilities (irrigation, lighting, gas, septic)?",
        "Site access for equipment (gates, soft ground, overhead clearance)",
        "Traffic / pedestrian exposure (roadside, parking lot, school, park)",
        "Proximity to neighbours, buildings, or protected areas",
        "Existing site hazards (debris, open water, unstable structures)",
        "Seasonal / weather risks expected (smoke season, frost, rain)",
        "Wildlife / pest risk (ticks, wasps, bears in the area)",
        "Water source availability (dust suppression, irrigation testing)",
        "Portable sanitation / site facilities required?",
    ]))

    h.append("<h2>Permits, Certifications &amp; Regulatory Requirements</h2>")
    h.append("<p>For each, mark Required or N/A, with status and responsible person:</p>")
    h.append(_ul([
        "BC 1 Call locate — 3 business days before digging",
        "Road use / lane closure permit (municipality)",
        "Traffic Control Plan (TCP)",
        "City / District permit (retaining wall, hardscape, fencing)",
        "WHMIS / SDS binder for products on site (fuel, sealers, fertilizer)",
        "Equipment operator certification (mini excavator, scissor lift)",
        "Confined space assessment (valve vaults, manholes)",
        "Notification to adjacent property owners",
        "Strata / HOA / property manager approval",
        "WorkSafeBC Prime Contractor designation confirmed and posted at site entrance",
    ]))

    h.append("<h2>Project-Level Hazard Assessment</h2>")
    h.append("<p>Hazards anticipated over the life of the project. Risk is rated before and after controls "
             "(H/M/L), controls specified, and the applicable SWPs are pre-mapped &mdash; confirm workers are "
             "trained on each before mobilization. Daily FHSPs/FLHAs address conditions on each day.</p>")
    h.append(_grouped(["Hazard", "Applicable SWPs"], [
        ("Underground & ground conditions", [
            ["Underground utilities — public (BC 1 Call) and private", "SWP-01, SWP-02"],
            ["Soil instability, slope failure, or trench collapse (>1.2 m deep)", "SWP-01"],
            ["Contaminated soil or fill material", "—"],
            ["High water table or groundwater intrusion", "SWP-01"],
            ["Expansive / clay soils affecting equipment stability", "SWP-03"],
        ]),
        ("Equipment & heavy machinery", [
            ["Mini excavator, skid steer, or plate compactor in use", "SWP-03, SWP-04"],
            ["Operator qualifications — certifications verified before mobilization?", "SWP-03"],
            ["Equipment access route — soft ground, width clearance, overhead", "SWP-03"],
            ["Fuel and fluid storage on site", "—"],
            ["Tool and equipment theft / site security", "—"],
        ]),
        ("Traffic, pedestrian & public safety", [
            ["Roadside or boulevard work — TCP required?", "SWP-13"],
            ["Shared access with occupied building, school, or park", "SWP-13"],
            ["Backing and maneuvering in confined spaces", "SWP-03, SWP-13"],
            ["Debris / throw hazard from mowers, cutters, compactors", "SWP-10, SWP-11"],
            ["Noise bylaw hours / neighbour disruption plan", "—"],
        ]),
        ("Dust & air quality", [
            ["Silica dust — concrete or paver cutting throughout project", "SWP-06"],
            ["Wildfire smoke exposure (seasonal) — N95s on hand", "SWP-14"],
            ["Concrete / mortar mixing — alkaline burn risk", "SWP-06"],
            ["Dust suppression on dry sites", "—"],
        ]),
        ("Environmental & seasonal conditions", [
            ["Heat stress — extended outdoor work during summer months", "SWP-15"],
            ["Cold stress / frost — early season or late-season work", "—"],
            ["Ticks — brushy or wooded areas involved in scope", "—"],
            ["Wildfire evacuation — site near interface zone?", "SWP-14"],
            ["Erosion and sediment control during construction", "—"],
        ]),
        ("Electrical", [
            ["Overhead power lines — site proximity / equipment height", "SWP-03"],
            ["Landscape lighting or irrigation wiring — low-voltage and 120V", "SWP-07, SWP-08"],
            ["Temporary power on site (generator, extension cords, GFCI)", "—"],
            ["Electrical disconnects / lockout required for any phase", "SWP-07"],
        ]),
        ("Ergonomics & manual handling", [
            ["Repetitive heavy lifting (pavers, boulders, sod rolls, trees)", "SWP-09"],
            ["Prolonged awkward postures (trench work, sod laying)", "SWP-09"],
            ["Vibration exposure — compaction and power tools", "SWP-04, SWP-11"],
            ["Crew size adequate for manual handling tasks planned?", "SWP-09"],
        ]),
        ("Cutting, trimming & chainsaw operations", [
            ["String trimmer / brushcutter — thrown debris, vibration", "SWP-11"],
            ["Chainsaw — kickback, laceration, falling limbs", "SWP-12"],
            ["Retaining wall / paver cutting — silica, blade contact", "SWP-05, SWP-06"],
            ["Mowing — commercial rider and walk-behind", "SWP-10"],
        ]),
        ("Subcontractors, prime contractor & coordination", [
            ["Prime Contractor obligations — Dario's responsible for worksite OH&S program", "—"],
            ["Other employers on site — safety plan received and reviewed before mobilization?", "—"],
            ["Daily FHSP/FLHA coordination between crews and subs", "—"],
            ["Client / public on site during construction phases", "SWP-13"],
        ]),
    ]))

    h.append("<h2>PPE &amp; Safety Equipment for This Project</h2>")
    h.append("<p>Confirmed on site before Day 1, in quantities sufficient for the crew:</p>")
    h.append(_ul([
        "CSA steel/composite-toe boots (all crew)", "N95 respirators — smoke season and silica work",
        "First aid kit (Level 1 minimum, on site)", "Safety glasses and/or face shields",
        "Anti-vibration gloves — compaction phases", "Fire extinguisher (if fuel storage or cutting)",
        "Hearing protection", "Sunscreen and wide-brim sun hats",
        "Traffic control equipment (cones, signs, vests)", "Work gloves (cut-resistant and general)",
        "Tick repellent (DEET 20–30%)", "GFCI outlets for all outdoor power tools",
        "Hi-visibility vests (Class 2) — roadside", "WHMIS / SDS binder for products on site",
        "Spill kit (if fuel stored on site)", "Hard hats — overhead hazard phases",
    ]))

    h.append("<h2>Emergency Preparedness</h2>")
    h.append("<p>Records the on-site muster point, nearest cross street, nearest hospital and urgent care, PM "
             "cell, first aid attendant and cert level, and kit location, plus a response plan for each "
             "scenario: serious injury on site; utility strike (gas, hydro, telecom); equipment rollover or "
             "entrapment; wildfire / smoke evacuation; hazardous spill (fuel, chemical).</p>")
    h.append(_table(["Key Contact", "Number"], [
        ["Nearest Hospital", "Kelowna General Hospital — 2268 Pandosy St — (250) 862-4000"],
        ["WorkSafeBC", "1-888-621-7233"],
    ]))

    h.append("<h2>Action Items &amp; Sign-Off</h2>")
    h.append("<p>Action items that must be resolved before mobilization are listed with an owner, due date, "
             "and completion check. The PHA is signed by the Project Manager, Crew Lead, Worker Representative, "
             "and (for projects &gt;$50K or high hazard) the Owner / Operations Manager. It must be reviewed "
             "with the full crew on Day 1 before any work begins.</p>")

    h.append('<p class="footer-note">Dario\'s Landscape Services Ltd. &middot; Project Hazard Assessment (PHA) '
             'v3 &middot; Complete before mobilization; review with full crew on Day 1. Retain for a minimum of '
             '2 years. Serious incidents: WorkSafeBC 1-888-621-7233. Governed by the OH&amp;S Program Manual.</p>')
    return "\n".join(h)


# ══════════════════════════════════════════════════════════════════════════════════
#  FIELD HEALTH & SAFETY PLAN (FHSP) — CONSTRUCTION
# ══════════════════════════════════════════════════════════════════════════════════
def _fhsp_html() -> str:
    h: list[str] = []
    h.append(_form_note(
        "This is the daily Field Health &amp; Safety Plan (FHSP) for the Construction Division. It is completed "
        "<strong>before work begins each shift</strong> and updated mid-shift if scope, conditions, or crew "
        "change. The content below is the standing form &mdash; the day's details, confirmations and sign-offs "
        "are filled in on site. &#9888; <strong>BC 1 Call is required before any digging, trenching, or "
        "excavation &mdash; minimum 3 business days in advance; the locate ticket number must be recorded "
        "before any ground disturbance.</strong>"))

    h.append("<h2>1. Project &amp; Crew Information</h2>")
    h.append("<p>Records the date, project/job #, site address, supervisor/crew lead, crew size, weather, the "
             "BC 1 Call ticket # and validity (if digging), whether locates are marked on site, the AQHI "
             "rating and smoke action, and the Humidex / heat risk &mdash; plus each crew member present with "
             "signature and role.</p>")

    h.append("<h2>2. Scope of Work Today</h2>")
    h.append("<p>All tasks being performed this shift are checked:</p>")
    h.append(_ul([
        "Site prep / layout / staking", "Hand excavation / trenching", "Powered trenching",
        "Mini excavator / skid steer", "Grading — rough", "Grading — fine / finish", "Compaction",
        "Soil import / export", "Retaining wall construction", "Paver / hardscape install",
        "Concrete cutting / grinding", "Concrete / mortar mixing", "Drainage / catch basin",
        "Irrigation rough-in", "Irrigation head install & wiring", "Irrigation controller / wiring",
        "Landscape lighting install", "Planting — trees / shrubs", "Sodding / hydroseed",
        "Roadside / boulevard work", "Work in occupied / public area", "Other (describe)",
    ]))

    h.append("<h2>3. Site Setup &amp; Access Controls</h2>")
    h.append("<p>Confirmed before work begins (mark N/A if not applicable today). No work begins until all "
             "applicable items are confirmed.</p>")
    h.append(_table(["Setup Item", "Required Today?"], [
        ["BC 1 Call locate confirmed — ticket # in Section 1", "Yes — if any digging"],
        ["Utility flags / marks visible and clear to all crew", "Yes — if digging"],
        ["Excavation tolerance zone marked (0.6 m from locate)", "Yes — if digging"],
        ["Work zone fenced / barricaded from public access", "Yes — public site"],
        ["Traffic control: cones, signs, TCP in place (if roadside)", "Yes — if roadside"],
        ["Equipment access route confirmed — clearance, soft ground", "If equipment on site"],
        ["Pre-start inspection completed for all equipment today", "Yes — daily"],
        ["Emergency muster point identified and communicated", "Yes — daily"],
    ]))

    h.append("<h2>4. Hazard Identification &amp; Controls</h2>")
    h.append("<p>The pre-set standing controls for construction work. For each hazard present today, controls "
             "are confirmed and residual risk rated (H/M/L); site-specific hazards are added in blank rows.</p>")
    h.append(_grouped(["Hazard", "Pre-Set Controls"], [
        ("Underground utilities — primary hazard on every dig", [
            ["Public utility strike — gas, hydro, telecom, water", "BC 1 Call ticket obtained (min. 3 days). Flags/marks visible before any dig. Hand expose to confirm depth within tolerance zone (0.6 m). Stop work immediately if unmarked line encountered — call 911 for gas."],
            ["Private / unmarked utilities — irrigation, lighting, gas, drainage", "Client/property manager consulted before mobilization. Hand dig first in any area with suspected private lines. All crew briefed on known private utility locations."],
            ["Damage to located utility during excavation", "Tolerance zone (0.6 m) observed. No mechanical digging within 0.6 m of a locate. Hand expose first. Operator on standby during hand exposure."],
        ]),
        ("Excavation & ground conditions", [
            ["Trench or excavation deeper than 1.2 m — collapse risk", "Excavation >1.2 m requires sloped walls (1:1 min) or shoring before entry. No workers enter unprotected trench. Supervisor inspects before each entry."],
            ["Unstable, soft, or saturated ground — equipment rollover", "Ground conditions assessed before equipment placement. Operator confirms stability. Outriggers/mats deployed where required. Supervisor approves placement on slopes."],
            ["Spoil pile instability — collapse onto workers or into trench", "Spoil piled minimum 0.6 m from trench edge. Excess spoil removed from zone promptly."],
            ["Unexpected underground obstruction (rock, debris, old structure)", "Stop mechanical digging. Assess by hand. Supervisor notified before proceeding."],
        ]),
        ("Heavy equipment operation", [
            ["Equipment operator not trained / certified on this machine", "Only trained operators use equipment. Certifications verified by supervisor before mobilization. No one operates equipment they are not certified on."],
            ["Struck-by risk — workers in equipment swing / travel zone", "Exclusion zone enforced: no worker within 3 m of operating equipment unless in direct communication with operator. Operator must see worker before moving."],
            ["Equipment backing without spotter", "Spotter required for all reversing maneuvers. Operator and spotter maintain visual contact throughout."],
            ["Pre-start inspection not completed — defective equipment", "Pre-start inspection completed before first use each day. Defect = equipment tagged and removed from service."],
            ["Equipment tip-over on slope or soft ground", "Ground stability assessed before positioning. Maximum rated slope observed. ROPS and seatbelt confirmed functional."],
        ]),
        ("Traffic & pedestrian (if applicable)", [
            ["Roadside or boulevard work — workers in traffic", "Traffic Control Plan (TCP) in place before work begins. Hi-vis vests Class 2 worn. Flagpersons in position. WorkSafeBC TCP standards followed."],
            ["Members of public entering work zone", "Site barricaded or fenced to prevent unauthorized entry. Signage in place. Supervisor monitors perimeter."],
            ["Debris / thrown material risk to bystanders", "Minimum 10 m exclusion for mowing/cutting near public. Stop equipment if public approaches."],
        ]),
        ("Dust, silica & air quality", [
            ["Silica dust — concrete or paver cutting, grinding, drilling", "Wet cutting method used. N95 respirator worn for all dry cutting. Minimize cutting time. Direct dust away from crew and public."],
            ["Concrete / mortar mixing — alkaline burn (eyes, skin)", "Safety glasses and work gloves worn during mixing. Rinse skin contact immediately. Eye wash available on site."],
            ["Wildfire smoke — AQHI check required each shift", "AQHI checked and recorded in Section 1. N95 respirators in crew vehicle. Follow SAF-001 wildfire smoke protocol if AQHI ≥ 7."],
            ["Exhaust / CO — generator or equipment in semi-enclosed space", "Gas equipment not operated in enclosed areas without confirmed ventilation. Prefer battery tools in confined access."],
            ["Dust suppression on dry grading or demolition", "Water applied to grading areas in dry conditions. Crew and public downwind considered before starting."],
        ]),
        ("Electrical", [
            ["Overhead power lines — equipment height conflict", "Minimum 3 m clearance maintained from all overhead lines. Operator briefed on line locations. Spotter assigned when operating near lines."],
            ["Irrigation controller / solenoid wiring — live voltage", "Power confirmed off at controller before wiring work begins. Lockout applied if main disconnect accessible. Test with voltage tester before touching."],
            ["Low-voltage landscape lighting wiring", "Power transformer disconnected before wiring. Confirm circuit dead with tester before splicing."],
            ["Outdoor power tools / generator — electrocution risk", "GFCI protection on all outdoor power circuits. Cords inspected before use. Tools rated for outdoor use."],
        ]),
        ("Manual handling & ergonomics", [
            ["Heavy lifting — pavers, boulders, retaining wall blocks, trees, sod rolls", "Team lift for items >23 kg. Mechanical aid (mini excavator, cart, dolly) used where possible. Crew briefed on lift plan before starting."],
            ["Repetitive strain — compaction, sod laying, hand digging", "Task rotation to limit repetitive motion. Rest breaks enforced. Workers report pain without repercussion."],
            ["Vibration — plate compactor, hammer drill, powered trencher", "Anti-vibration gloves worn. Continuous exposure limited. Supervisor monitors extended vibration tool use."],
        ]),
        ("Environmental conditions", [
            ["Heat stress — heavy labour in summer heat", "Water available at all times. Humidex >35°C triggers paid rest breaks in shade or vehicle. See SAF-001 heat stress protocol."],
            ["Ticks — vegetation clearing, planting, grading in brushy areas", "Tick repellent applied before shift. Crew checks exposed skin after vegetated areas. Any attached tick reported to supervisor."],
            ["Lightning / severe weather — workers in open excavation", "Monitor weather forecast. Clear all workers from excavations at first sign of lightning. Resume only when confirmed safe."],
        ]),
    ]))

    h.append("<h2>5. Equipment Pre-Start Checklist</h2>")
    h.append("<p>Completed for each piece of powered equipment on site today &mdash; ROPS/guards, seatbelt, "
             "fluid levels, leaks/damage, and any defect noted. Any defect = equipment tagged out of service.</p>")

    h.append("<h2>6. PPE Confirmed</h2>")
    h.append("<p>All PPE is available and being worn:</p>")
    h.append(_table(["PPE Item", "Required"], [
        ["CSA steel/composite-toe boots", "All crew, all times on site"],
        ["Hi-visibility vest (Class 2)", "Roadside, parking lot, and public-area work"],
        ["Hard hat", "Any overhead hazard — wall build, tree work, near equipment"],
        ["Safety glasses / face shield", "Cutting, grinding, mixing, compaction, trimming"],
        ["Hearing protection", "All powered equipment operation — NO personal earbuds"],
        ["Work gloves", "General — cut-resistant for hardscape and retaining wall work"],
        ["Anti-vibration gloves", "Compaction, hammer drill, powered trenching"],
        ["N95 respirator", "Concrete/paver cutting; AQHI ≥ 7 (wildfire smoke)"],
        ["Sunscreen SPF 30+ / wide-brim hat", "Strongly recommended — extended outdoor summer work"],
        ["Tick repellent", "Vegetation clearing, planting, work in brushy areas"],
        ["First aid kit / trauma kit", "Must be in crew vehicle — accessible at all times on site"],
    ]))

    h.append("<h2>7. Morning Crew Meeting — Pre-Shift Briefing</h2>")
    h.append("<p>The crew lead holds a brief meeting before work begins. Open floor &mdash; crew can raise "
             "concerns without repercussion. Topics covered:</p>")
    h.append(_ul([
        "BC 1 Call ticket confirmed — locate markings reviewed with crew",
        "Today's scope of work, crew assignments, and sequence of tasks",
        "Excavation plan — depth, method, trench protection if >1.2 m",
        "Equipment operators confirmed — certifications, exclusion zones, spotter assignments",
        "Site setup confirmed — fencing, barricades, traffic control (if roadside)",
        "Utility locations reviewed — flags visible and understood by all crew",
        "PPE check — everyone confirmed before starting",
        "AQHI, heat, and weather conditions for today",
        "Lift plan for any heavy manual handling today (pavers, boulders, trees)",
        "Emergency muster point confirmed",
        "Nearest hospital: Kelowna General — 2268 Pandosy St — (250) 862-4000",
        "Any new hazard or condition raised by crew (open floor)",
    ]))

    h.append("<h2>8. Mid-Shift Updates &amp; 9. Supervisor Sign-Off</h2>")
    h.append("<p>Any change in conditions, scope, or crew during the shift is logged with the time, the "
             "hazard/change/action taken, and initials. By signing off, the supervisor confirms the morning "
             "crew meeting was held, BC 1 Call is confirmed (if digging), site setup is complete, hazards have "
             "been communicated, controls are in place, and PPE is available and being worn.</p>")

    h.append('<p class="footer-note">Dario\'s Landscape Services Ltd. &middot; Field Health &amp; Safety Plan '
             '(FHSP) &mdash; Construction Division &middot; Complete before work begins; update mid-shift on any '
             'change. Retain for a minimum of 2 years. Utility strikes: WorkSafeBC 1-888-621-7233. Kelowna '
             'General Hospital — 2268 Pandosy St — (250) 862-4000. Governed by SAF-001.</p>')
    return "\n".join(h)


# ── docs to seed: (slug, title, category, layer, code, version, sort, summary, builder) ──
_DOCS = [
    ("ohs-program-manual", "OH&S Program Manual", "manual", 1, None, "1.0", 0,
     "The full written OH&S program — policy, roles, JHSC, hazard system, training, PPE, "
     "incident reporting, emergency response, records and review.", _manual_html),
    ("worker-safety-signoff", "Worker Safety Sign-Off & PPE Acknowledgement", "signoff", 1,
     "SAF-001 Form", "2.2", 2,
     "Hire/annual sign-off: OH&S awareness, SWP training acknowledgement and PPE issuance.", _signoff_html),
    ("project-hazard-assessment", "Project Hazard Assessment (PHA)", "pha", 3, "PHA", "3", 1,
     "Pre-mobilization project hazard assessment — scope, site conditions, permits, hazard→SWP "
     "mapping, PPE, emergency prep and sign-off.", _pha_html),
    ("fhsp-construction", "Field Health & Safety Plan — Construction", "fhsp", 4, "FHSP", None, 1,
     "The daily pre-shift field plan for construction — scope, site setup, hazard→control table, "
     "equipment pre-start, PPE and the morning crew briefing.", _fhsp_html),
]


async def seed_safety_docs_if_missing(db):
    """Insert the Manual, Sign-Off, PHA and FHSP if their slugs are not present. Never updates."""
    rows = await db._q("SELECT slug FROM safety_documents", [])
    have = {r["slug"] for r in (rows or [])}
    inserted = 0
    for slug, title, cat, layer, code, version, sort, summary, builder in _DOCS:
        if slug in have:
            continue
        body = builder()
        await db._x(
            """INSERT INTO safety_documents
               (slug, title, category, layer, code, summary, html, plain_text, version,
                status, field_visible, sort_order, updated_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 1, ?, 'seed')""",
            [slug, title, cat, layer, code, summary, body, _plain(body), version, sort])
        inserted += 1
    if inserted:
        logger.info("Seeded %d Safety Program documents (manual/signoff/PHA/FHSP)", inserted)
    return inserted
