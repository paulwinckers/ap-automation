"""
Starter load for the 15 Safe Work Procedures (SWP-01 … SWP-15), Layer 2 of the Safety
Management System. Content is transcribed from Dario's Safe Work Procedures Manual v1.0.

IMPORTANT — this is a *starter* load, not an authority:
  * Each SWP is inserted ONLY IF its slug does not already exist.
  * It is NEVER updated or overwritten here.
Once a procedure is in the table, the admin page (/ops/safety-program) owns it — staff
edit, re-version and publish there (and new SWPs are authored there or via the connector).
So editing a seeded SWP in the app is safe; a later deploy will not clobber it.
"""
import logging

from app.api.safety_seed import _plain

logger = logging.getLogger(__name__)


def _esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _risk(level: str) -> str:
    lv = (level or "").upper()
    return f"<strong>{lv}</strong>" if lv == "HIGH" else lv


def _render(swp: dict) -> str:
    p: list[str] = []
    p.append(f'<p class="lead"><strong>Applicable roles:</strong> {_esc(swp["roles"])}</p>')

    p.append("<h2>Hazards identified</h2>")
    p.append("<table><thead><tr><th>Hazard</th><th>Risk level</th></tr></thead><tbody>")
    for hz, lv in swp["hazards"]:
        p.append(f"<tr><td>{_esc(hz)}</td><td>{_risk(lv)}</td></tr>")
    p.append("</tbody></table>")

    p.append("<h2>Required PPE</h2>")
    p.append("<p>All items below must be confirmed present and in good condition before work starts.</p>")
    p.append("<ul>")
    for item in swp["ppe"]:
        p.append(f"<li>{_esc(item)}</li>")
    p.append("</ul>")

    p.append("<h2>Step-by-step procedure</h2>")
    p.append('<table><thead><tr><th>#</th><th>Action</th><th>Key control / hazard management</th></tr></thead><tbody>')
    for num, action, control in swp["steps"]:
        p.append(f"<tr><td><strong>{_esc(num)}</strong></td><td>{_esc(action)}</td><td>{_esc(control)}</td></tr>")
    p.append("</tbody></table>")

    p.append("<h2>Emergency response</h2>")
    for e in swp["emergency"]:
        if ":" in e:
            label, rest = e.split(":", 1)
            p.append(f"<p><strong>{_esc(label)}:</strong>{_esc(rest)}</p>")
        else:
            p.append(f"<p>{_esc(e)}</p>")

    p.append(
        '<p class="footer-note">Dario\'s Landscape Services Ltd. &middot; Safe Work Procedure '
        f'{swp["code"]} &middot; Revision {swp["rev"]} &middot; Prepared and reviewed by Supervisor; '
        'approved by Owner. Review annually or after any related incident or near-miss.</p>'
    )
    return "\n".join(p)


# ── The 15 procedures, verbatim from the SWP Manual ──────────────────────────────────
SWPS: list[dict] = [
    {
        "sort": 1, "code": "SWP-01", "slug": "swp-01-excavation-and-trenching",
        "title": "Excavation and Trenching", "rev": "1.0",
        "roles": "Construction crew, Supervisor",
        "summary": "Trench protection, locates and cave-in controls for digging work.",
        "hazards": [
            ("Unlocated underground utilities (gas, hydro, telecom, water, sewer)", "HIGH"),
            ("Trench cave-in or collapse", "HIGH"),
            ("Workers struck by excavator bucket or spoil pile", "HIGH"),
            ("Excavator rollover on unstable or sloped ground", "HIGH"),
            ("Exposure to contaminated soil or groundwater", "MEDIUM"),
            ("Spoil pile instability — slide back into trench", "MEDIUM"),
            ("Engulfment in unstable trench wall", "HIGH"),
            ("Inadequate access/egress from trench", "MEDIUM"),
        ],
        "ppe": [
            "CSA steel-toe boots",
            "Hard hat (CSA Z94.1, Class E)",
            "High-visibility vest (Class 2)",
            "Safety glasses",
            "Work gloves",
            "Hearing protection when operating equipment nearby",
        ],
        "steps": [
            ("PRE", "Confirm BC 1 Call locate ticket is active and locate flags/marks are visible on site.", "Minimum 3 business days advance notice required. Record ticket # on FHSP. DO NOT DIG without a valid ticket."),
            ("PRE", "Review site drawings / as-builts for known utility locations.", "Treat all unmarked areas as potentially containing utilities."),
            ("PRE", "Mark the proposed dig area with paint or stakes.", "Stay minimum 0.6 m (2 ft) from any locate flag — hand-dig within tolerance zone."),
            ("PRE", "Assess soil type and trench depth. If trench will exceed 1.2 m (4 ft) depth, a trench protection plan is mandatory.", "OHS Regulation Part 20. Options: sloped walls, shoring, trench box."),
            ("PRE", "Establish exclusion zone — no unauthorized persons within 3 m of equipment during operation.", "Use cones, tape, or flagging. Supervisor to brief all crew."),
            ("1", "Position excavator on stable ground, away from spoil pile and trench edge.", "Minimum distance from trench edge = 1× trench depth, or as engineered."),
            ("2", "Begin excavation. Stop immediately if any locate marks, unexpected pipes, cables, or discoloured soil are encountered.", "Call BC 1 Call 1-800-474-6886 if unmarked utility suspected. Do not resume until cleared."),
            ("3", "Place spoil pile minimum 0.6 m from trench edge on the uphill side.", "Spoil pile must not compromise trench wall stability."),
            ("4", "Install trench protection before any worker enters a trench deeper than 1.2 m.", "Shoring, benching, sloping, or trench box per engineering / competent person review."),
            ("5", "Provide safe access/egress: ladder or steps every 8 m for trenches deeper than 1.2 m.", "Ladder must extend 1 m above trench edge."),
            ("6", "Inspect trench walls before each entry and after any rain, freeze-thaw, or vibration.", "Competent person inspection required. Document on FHSP."),
            ("7", "Complete work. Backfill and compact immediately after work is done in each section.", "Do not leave open trenches unattended or unbarricaded overnight."),
            ("8", "Remove all trench protection before backfilling if using a trench box — never bury it.", "Remove box incrementally from bottom up as backfill proceeds."),
        ],
        "emergency": [
            "GAS HIT: Stop immediately. Evacuate all crews and bystanders 300 m. Call 911 + FortisBC 1-800-663-9911. Do not operate any electrical equipment.",
            "POWER LINE HIT: Stop. Call 911 + BC Hydro 1-888-769-3766. Stay minimum 10 m from all equipment — assume everything is live.",
            "TRENCH COLLAPSE WITH WORKER INSIDE: Call 911 immediately. DO NOT enter the trench — second collapse risk. Call WorkSafeBC 1-888-621-7233. Preserve scene.",
        ],
    },
    {
        "sort": 2, "code": "SWP-02", "slug": "swp-02-underground-utility-locating",
        "title": "Underground Utility Locating (BC 1 Call)", "rev": "1.0",
        "roles": "All field crew, Supervisor",
        "summary": "Getting and honouring BC 1 Call locates before any dig.",
        "hazards": [
            ("Unlocated utilities struck during excavation or drilling", "HIGH"),
            ("Gas leak / fire / explosion following utility strike", "HIGH"),
            ("Electrocution from severed power cable", "HIGH"),
            ("Water or sewer damage and flooding", "MEDIUM"),
            ("Service interruption to clients or public", "MEDIUM"),
        ],
        "ppe": [
            "CSA steel-toe boots",
            "High-visibility vest",
            "Safety glasses",
            "Work gloves",
        ],
        "steps": [
            ("PRE", "Identify the full dig area — mark it on a sketch or site drawing.", "Include all areas where power tools, drills, spikes, or excavation equipment will be used."),
            ("PRE", "Call BC 1 Call: 1-800-474-6886, or submit online at bc1call.ca. Request locates minimum 3 business days before any dig.", "Saturdays, Sundays, and statutory holidays do NOT count as business days."),
            ("PRE", "Record the BC 1 Call ticket number on the FHSP for that day's work. Work cannot begin without a valid ticket on file.", "Ticket # must be on the FHSP before breaking ground."),
            ("PRE", "Confirm all locators have attended the site and locate marks/flags are clearly visible.", "If a utility owner did not respond, call BC 1 Call to follow up. Do not proceed if any utility owner is outstanding."),
            ("PRE", "Review locate marks with the full crew during morning safety briefing.", "Paint colours: yellow = gas/oil, red = electric, orange = telecom, blue = water, green = sewer/storm."),
            ("1", "Within the 0.6 m (2 ft) tolerance zone around any locate mark — hand-dig only. Once line is exposed you are allowed within 1 foot.", "No powered equipment within 0.6 m of a locate mark."),
            ("2", "During machine excavation, slow down and use caution as you approach the depth of buried services.", "Average depths: gas 0.6 m, water 1.5 m, hydro 0.9–1.2 m — but depths vary. Do not assume."),
            ("3", "If an unidentified or unexpected object is encountered: STOP. Expose by hand-digging.", "Identify the material before continuing. Call BC 1 Call if you suspect an unmarked utility."),
            ("4", "At end of dig: confirm all locate marks remain visible if work continues on subsequent days.", "Locate tickets are typically valid for 30 days from issue — confirm before continuing."),
        ],
        "emergency": [
            "If a utility is struck: STOP all work. Evacuate the area.",
            "GAS LINE: Call 911 + FortisBC 1-800-663-9911. Minimum 300 m evacuation.",
            "ELECTRICAL: Call 911 + BC Hydro 1-888-769-3766. Minimum 10 m from all equipment.",
            "ALL STRIKES: Report to WorkSafeBC 1-888-621-7233. Notify supervisor immediately.",
        ],
    },
    {
        "sort": 3, "code": "SWP-03", "slug": "swp-03-mini-excavator-skid-steer",
        "title": "Mini Excavator / Skid Steer Operation", "rev": "1.0",
        "roles": "Certified equipment operators, Supervisor",
        "summary": "Safe operation of mini excavators and skid steers — exclusion zones, slopes, overhead lines.",
        "hazards": [
            ("Workers struck by swinging bucket, arm, or equipment", "HIGH"),
            ("Rollover on sloped, uneven, or soft ground", "HIGH"),
            ("Contact with overhead power lines", "HIGH"),
            ("Unlocated underground utilities struck by bucket", "HIGH"),
            ("Pedestrian or bystander in exclusion zone", "HIGH"),
            ("Equipment tipping during lifting operations", "MEDIUM"),
            ("Operator fatigue or distraction", "MEDIUM"),
            ("Equipment failure — brakes, hydraulics, ROPS", "MEDIUM"),
        ],
        "ppe": [
            "CSA steel-toe boots",
            "Hard hat (CSA Z94.1, Class E)",
            "High-visibility vest (Class 2)",
            "Safety glasses",
            "Hearing protection",
            "Seatbelt / operator restraint (mandatory at all times while operating)",
        ],
        "steps": [
            ("PRE", "Complete Equipment Pre-Start Inspection (form on FHSP). Check hydraulics, ROPS, seatbelt, horn, bucket teeth, tracks/tyres, lights.", "Do not operate any equipment with a defect affecting safety. Tag OUT OF SERVICE and report immediately."),
            ("PRE", "Confirm BC 1 Call ticket is valid and locate marks are visible before any digging.", "See SWP-02. No digging without a valid locate ticket."),
            ("PRE", "Identify overhead and lateral hazards: power lines, tree branches, structures.", "Minimum 3 m clearance from overhead power lines at all times. If clearance cannot be maintained, stop and contact BC Hydro."),
            ("PRE", "Establish and communicate the exclusion zone — minimum 3 m radius from equipment, all sides.", "Use cones/tape. Supervisor to ensure no unauthorized persons enter the zone."),
            ("1", "Mount using 3-point contact. Fasten seatbelt / lower operator restraint bar before starting.", "Never operate without the seatbelt fastened or restraint bar lowered (skid steer)."),
            ("2", "Sound horn before moving. Check all blind spots.", "Use a spotter whenever reversing in a congested area or near personnel."),
            ("3", "Travel with bucket/attachment low (maximum 300 mm off ground) to lower centre of gravity.", "Never travel on a slope with a raised or loaded bucket."),
            ("4", "On slopes: travel straight up or down — never across a slope exceeding the rated side-slope angle.", "Check manufacturer specs. If in doubt, do not attempt."),
            ("5", "Swing the bucket slowly and smoothly. Never use the bucket to strike, pry, or hammer material.", "Prying/striking can cause sudden structural failure."),
            ("6", "When leaving the machine: lower all attachments to the ground, engage park brake, shut down engine, remove key.", "Never leave a running machine unattended."),
            ("7", "At end of shift: clean machine, complete log, report any defects to supervisor.", "Defects must be repaired before next use."),
        ],
        "emergency": [
            "ROLLOVER: Stay in cab — ROPS protects the operator. Do not jump. Call 911 if injury. Bring in First Aid attendant to assess any injuries or potential injuries.",
            "POWER LINE CONTACT: Do not exit cab. Call 911. Warn bystanders to stay away. Wait for BC Hydro to clear the line.",
            "WORKER STRUCK: Call 911. Shut down equipment. Do not move injured worker unless in immediate danger. Notify WorkSafeBC 1-888-621-7233.",
        ],
    },
    {
        "sort": 4, "code": "SWP-04", "slug": "swp-04-plate-compactor",
        "title": "Plate Compactor Operation", "rev": "1.0",
        "roles": "Construction crew",
        "summary": "Compactor operation — vibration limits, CO, silica dust and trench-edge clearance.",
        "hazards": [
            ("Hand-arm vibration — extended operation", "MEDIUM"),
            ("Foot / toe injury from compactor contact", "HIGH"),
            ("Compactor slipping into open trench or edge", "HIGH"),
            ("Carbon monoxide from gasoline engine in enclosed space", "HIGH"),
            ("Dust inhalation — silica in soil or base material", "MEDIUM"),
            ("Noise — hearing damage from prolonged operation", "MEDIUM"),
            ("Trip/fall on uneven compacted surface", "LOW"),
        ],
        "ppe": [
            "CSA steel-toe boots",
            "Safety glasses",
            "Hearing protection (mandatory during operation)",
            "Anti-vibration gloves",
            "N95 respirator (silica-containing materials — crushed rock, concrete base)",
            "Dust mask minimum when working in dry conditions",
        ],
        "steps": [
            ("PRE", "Inspect compactor: fuel level, engine oil, vibration plate condition, handles, throttle cable.", "Do not operate a compactor with a cracked plate or damaged handle."),
            ("PRE", "Confirm area is clear of workers and public. Establish minimum 3 m exclusion zone.", "The compactor can shift unexpectedly — keep bystanders back."),
            ("PRE", "Check for underground utilities in the compaction area.", "Compaction vibration can displace shallowly buried utilities. Confirm BC 1 Call ticket is valid."),
            ("1", "Start engine per manufacturer procedure. Allow to warm up.", "Gasoline engines: operate only outdoors or with adequate ventilation. Never in enclosed spaces."),
            ("2", "Begin compaction in straight overlapping passes (minimum 25% overlap).", "Work away from trench edges — minimum 0.6 m clearance from open edge."),
            ("3", "Use throttle to maintain steady plate speed. Do not force the machine.", "Let the machine do the work — forcing it increases vibration exposure and wear."),
            ("4", "Take vibration exposure breaks: maximum 2 hours continuous operation, then minimum 10-minute break.", "HAV (Hand-Arm Vibration) cumulative exposure limit per WorkSafeBC."),
            ("5", "On slopes: compact in straight lines up-and-down. Never operate across a steep slope.", "Compactor can lose traction and tip or slide. Maximum 15° side slope."),
            ("6", "Shut down engine before moving to a new area or clearing material from under the plate.", "Never place hands or feet under a running compactor."),
            ("7", "After use: shut down, allow to cool, check for fuel leaks, store upright.", "Store away from heat sources. Clean plate of debris."),
        ],
        "emergency": [
            "FOOT INJURY: Stop compactor immediately. Call 911 for serious injury. Apply first aid. Report to supervisor.",
            "CO SYMPTOMS (dizziness, nausea, headache): Stop engine immediately. Move to fresh air. Call 911 if serious.",
            "COMPACTOR INTO TRENCH: Do not attempt to retrieve without securing the trench. Assess for utility damage.",
        ],
    },
    {
        "sort": 5, "code": "SWP-05", "slug": "swp-05-retaining-wall-construction",
        "title": "Retaining Wall Construction", "rev": "1.0",
        "roles": "Construction crew, Supervisor",
        "summary": "Block wall builds — base prep, drainage, geogrid, manual handling and silica.",
        "hazards": [
            ("Unlocated underground utilities in excavation zone", "HIGH"),
            ("Wall block falling on worker — manual handling of heavy blocks", "HIGH"),
            ("Trench / excavation cave-in during prep", "HIGH"),
            ("Pinch points between blocks during placement", "HIGH"),
            ("Musculoskeletal injury — heavy, repetitive block handling", "HIGH"),
            ("Equipment struck-by during block delivery", "MEDIUM"),
            ("Wall failure or collapse during / after construction", "HIGH"),
            ("Silica exposure during cutting and grinding", "MEDIUM"),
        ],
        "ppe": [
            "CSA steel-toe boots",
            "Hard hat (CSA Z94.1, Class E) — during excavation and block delivery",
            "Safety glasses",
            "Work gloves (cut-resistant)",
            "N95 respirator when cutting or grinding blocks",
            "High-visibility vest during equipment operations",
        ],
        "steps": [
            ("PRE", "Confirm BC 1 Call ticket is valid. Mark all utility locate flags clearly before any excavation.", "See SWP-01 (Excavation) and SWP-02 (BC 1 Call). No digging without a valid ticket."),
            ("PRE", "Review wall design: height, batter (setback per course), geogrid requirements, drainage plan.", "Walls over 1.0 m must be designed per local requirements. Ensure geogrid and drainage materials are on site."),
            ("PRE", "Plan block delivery staging: blocks placed within reach of work area but clear of exclusion zone.", "Blocks weigh 20–40+ kg each. Stage to minimize carry distance and reduce MSI risk."),
            ("1", "Excavate base trench to required depth (minimum 150 mm below finished grade per manufacturer spec).", "Trench must be level and firm. Compact base material to 95% SPD minimum."),
            ("2", "Place and level granular base material. Check level along full length before laying first course.", "A level first course is critical. Take time here — errors compound with every course."),
            ("3", "Lay first course of blocks with setback batter as specified. Check level and alignment every 1–2 m.", "Use a rubber mallet to seat blocks. Never stand blocks on unsupported fill."),
            ("4", "Install drainage aggregate and drainage pipe (sock-wrapped) behind each course as work proceeds.", "Drainage is a structural requirement — do not skip or shortcut."),
            ("5", "Install geogrid at specified intervals (per design — typically the 1st, 3rd and 5th course for walls under 4 feet).", "Geogrid must extend full specified embedment length into retained soil. Do not cut short."),
            ("6", "When cutting blocks: use wet saw or dedicated block splitter. Wear N95 respirator.", "Never dry-cut without a respirator. Wet-cutting is preferred — see SWP-06."),
            ("7", "Continue courses. Maintain batter setback per manufacturer spec on every course.", "Check plumb and alignment regularly. Do not allow wall to lean forward (toe-out)."),
            ("8", "Cap blocks at top course. Ensure cap is fully glued/pinned per manufacturer specification.", "Cap adhesive must cure fully before backfill is placed against the wall."),
            ("9", "Backfill in 150–200 mm lifts behind wall. Compact each lift with hand tamper or plate compactor.", "Do not use heavy equipment within 1 m of the wall face until wall is fully constructed and drainage is complete."),
        ],
        "emergency": [
            "WALL COLLAPSE / BLOCK FALLS ON WORKER: Call 911 immediately. Do not attempt to move a worker with a suspected spinal injury. Notify WorkSafeBC 1-888-621-7233. Preserve scene.",
            "UTILITY STRIKE during excavation: see SWP-01 emergency section.",
        ],
    },
    {
        "sort": 6, "code": "SWP-06", "slug": "swp-06-concrete-paver-cutting-silica",
        "title": "Concrete / Paver Cutting and Grinding (Silica)", "rev": "1.0",
        "roles": "Construction crew",
        "summary": "Silica dust control — wet cutting, respirators and blade safety.",
        "hazards": [
            ("Respirable crystalline silica (RCS) inhalation — cutting / grinding concrete or stone", "HIGH"),
            ("Blade contact / kickback — lacerations, amputations", "HIGH"),
            ("Flying debris — eye, face injury", "HIGH"),
            ("Noise-induced hearing loss", "MEDIUM"),
            ("Vibration exposure (angle grinder / cut-off saw)", "MEDIUM"),
            ("Blade failure — fragment ejection", "HIGH"),
            ("Electrical hazard (corded tools outdoors)", "MEDIUM"),
            ("Dust cloud obscuring visibility for others on site", "MEDIUM"),
        ],
        "ppe": [
            "N95 respirator (minimum) — mandatory during all cutting/grinding. Half-face P100 respirator preferred for extended work.",
            "Face shield (over safety glasses) during grinding and cutting",
            "Safety glasses (underneath face shield)",
            "Hearing protection",
            "CSA steel-toe boots",
            "Work gloves",
            "Long sleeves — skin protection from debris",
        ],
        "steps": [
            ("PRE", "Confirm wet cutting is available: water attachment on saw or continuous water supply.", "WET CUTTING IS THE PREFERRED METHOD for all concrete and paver work. It reduces silica dust by up to 99%."),
            ("PRE", "Inspect blade: no cracks, chips, correct RPM rating for tool, correct blade type for material. Ensure the blade is properly installed.", "Never use a damaged blade. Check max RPM on blade against tool RPM. Mismatch = blade failure."),
            ("PRE", "Set up work area: identify direction of dust/debris, position bystanders upwind.", "Minimum 5 m exclusion zone for non-essential personnel during any cutting or grinding."),
            ("1", "Put on all PPE before starting tool. N95/P100 respirator on BEFORE starting the cut.", "Silica dust is generated immediately upon cutting — do not put the respirator on after dust is visible."),
            ("2", "For WET cutting: attach water feed, confirm water is flowing onto the blade before starting.", "Confirm water coverage throughout the cut. Pause and check if water supply is interrupted."),
            ("3", "For DRY cutting (only when wet cutting is not feasible): use vacuum dust shroud or local exhaust ventilation.", "Dry cutting without dust control is not permitted. Record reason for dry cut on FHSP."),
            ("4", "Mark cut line clearly. Secure material — it must not shift during the cut.", "Unsecured material causes kickback. Use clamps or have a second worker hold (clear of blade path)."),
            ("5", "Start tool. Allow blade to reach full speed before contacting material.", "Make the cut in a single smooth pass. Do not force or twist the blade."),
            ("6", "Complete cut. Allow blade to stop fully before setting tool down.", "Never set a running tool down. Place on a non-slip surface with blade away from workers."),
            ("7", "Clean up wet slurry or dry dust immediately with a wet method or HEPA vacuum.", "Never blow silica dust with compressed air. Do not dry-sweep — use wet method or HEPA vac only."),
            ("8", "Dispose of slurry and dust per site environmental requirements.", "Concrete slurry is high pH and may not be discharged to storm drains. Contain and dispose properly."),
        ],
        "emergency": [
            "LACERATION / BLADE CONTACT: Stop tool. Apply direct pressure to wound. Call 911 for serious injury.",
            "RESPIRATORY DISTRESS: Move worker to fresh air. Call 911 if symptoms persist.",
            "BLADE FRAGMENT EJECTION / EYE INJURY: Do not rub eye. Cover loosely. Call 911. All cutting injuries reported to supervisor and recorded on FHSP.",
        ],
    },
    {
        "sort": 7, "code": "SWP-07", "slug": "swp-07-irrigation-wiring",
        "title": "Irrigation Wiring — Controller and Solenoids", "rev": "1.0",
        "roles": "Irrigation technicians",
        "summary": "Controller and solenoid wiring — lockout, waterproof splices and zone testing.",
        "hazards": [
            ("Electrical shock from 120V controller power supply", "HIGH"),
            ("Electrical shock from improper wire splicing or insulation failure", "HIGH"),
            ("Underground electrical cables damaged during trenching", "HIGH"),
            ("Slip/trip on wet surfaces near controller", "LOW"),
            ("Eye injury from wire ends or tools", "MEDIUM"),
        ],
        "ppe": [
            "CSA steel-toe boots",
            "Safety glasses",
            "Insulated work gloves (when working near live circuits)",
            "Non-conductive footwear (dry conditions required at all times when working on electrical components)",
        ],
        "steps": [
            ("PRE", "Confirm BC 1 Call ticket is valid before any trenching for wire runs.", "See SWP-02. Irrigation wire runs parallel to or near existing buried utilities."),
            ("PRE", "Identify controller power source. Confirm the circuit breaker for the controller is turned OFF and LOCKED OUT before opening the controller panel.", "Use a lockout/tagout device. Test with a voltage tester before touching any wire terminals."),
            ("PRE", "Check wire type and size is appropriate for run length and number of stations.", "Undersized wire causes voltage drop — stations may not operate. Follow manufacturer specs."),
            ("1", "Open controller panel with power OFF and confirmed de-energized.", "Never assume power is off — always test with a non-contact voltage tester."),
            ("2", "Connect station wires to terminals per zone layout plan. Label each wire at both ends.", "Use wire nuts or waterproof connectors for all outdoor connections. No bare-wire twists."),
            ("3", "Connect common wire (white) to COM terminal. Ground wire to GND if required.", "A loose or incorrect common wire will cause all zones to fail — double-check."),
            ("4", "Run field wiring in trench at minimum 150 mm depth alongside mainline pipe.", "Separate irrigation wire from other electrical cables with at least 75 mm separation."),
            ("5", "Splice wires using waterproof wire connectors (e.g., DBY / DB wire connectors) at all field splices.", "Unprotected splices in wet soil cause corrosion and ground faults. Use only waterproof connectors. Mark and protect connection spots in the field (outdoor junction boxes)."),
            ("6", "At each solenoid: connect zone wire + common wire. Use waterproof connector.", "Confirm polarity is not required (solenoids are not polarity-sensitive — either wire to either terminal)."),
            ("7", "Restore power at breaker. Test each zone at controller before closing panel.", "Confirm activation — listen for solenoid click and confirm valve opens."),
            ("8", "Close and secure controller panel. Document zone layout in controller map.", "Leave zone map inside controller door for future technicians."),
        ],
        "emergency": [
            "ELECTRICAL SHOCK: Do not touch the person if they are still in contact with the source. Disconnect power at the breaker. Call 911. Provide first aid if qualified. Any suspected electrical shock must be reported to the supervisor and WorkSafeBC.",
        ],
    },
    {
        "sort": 8, "code": "SWP-08", "slug": "swp-08-landscape-lighting-low-voltage",
        "title": "Landscape Lighting — Low-Voltage Wiring", "rev": "1.0",
        "roles": "Irrigation/Lighting technicians",
        "summary": "Low-voltage lighting — GFCI transformers, load limits and overhead-line clearance.",
        "hazards": [
            ("Electrical shock at 120V transformer power supply", "HIGH"),
            ("Insulation damage from UV or rodents — shock / fire risk over time", "MEDIUM"),
            ("Eye injury from wire ends or staple gun", "MEDIUM"),
            ("Trip hazard from exposed wire during installation", "LOW"),
            ("BC hydro line contact during fixture installation near overhead lines", "HIGH"),
        ],
        "ppe": [
            "CSA steel-toe boots",
            "Safety glasses",
            "Insulated gloves when working on transformer terminals",
            "High-visibility vest when working in traffic-adjacent areas",
        ],
        "steps": [
            ("PRE", "Confirm transformer location. Confirm 120V outlet is GFCI-protected.", "Outdoor transformers must be on a GFCI-protected circuit. If not, install GFCI outlet before proceeding."),
            ("PRE", "Verify transformer is unplugged / de-energized before any wiring work.", "Test with voltage tester. Lock out if possible."),
            ("PRE", "Plan wire runs. Identify all underground utilities in the path.", "BC 1 Call required if any ground stakes or trenching exceeds 50 mm depth in unmarked areas."),
            ("1", "Install transformer at recommended height (typically 300 mm above grade) on mounting surface.", "Follow manufacturer mounting instructions. Transformer must be sheltered from direct soil contact."),
            ("2", "Run low-voltage cable along planned route. Stake or bury minimum 75 mm below grade.", "Avoid running wire across traffic or pedestrian paths at surface — bury or protect with conduit."),
            ("3", "Connect fixtures using quick-connect (vampire clip) or splice per manufacturer instructions.", "Do not over-tighten quick-connects — they cut through insulation. One firm squeeze is sufficient."),
            ("4", "Connect wire runs to transformer terminals. Do not exceed transformer wattage capacity on any zone.", "Total wattage per zone = sum of all fixture wattages. Overloading causes overheating and fire."),
            ("5", "Set timer/photocell per client schedule.", "Test all zones before leaving site. Confirm fixtures light up and timer functions correctly."),
            ("6", "Plug in transformer. Confirm GFCI does not trip. Test operation.", "If GFCI trips: there is a wiring fault. Do not reset repeatedly — find and fix the fault first."),
            ("7", "Secure all surface wire with appropriate staples or clips. Mark buried runs with marking paint.", "Document wire runs on as-built sketch and leave copy with client."),
        ],
        "emergency": [
            "GFCI KEEPS TRIPPING: Disconnect transformer. Do not energize until fault is found.",
            "ELECTRICAL SHOCK at transformer: Disconnect power. Call 911.",
            "OVERHEAD LINE CONCERN: Minimum 3 m clearance required. Stop work if clearance cannot be maintained. Contact BC Hydro.",
        ],
    },
    {
        "sort": 9, "code": "SWP-09", "slug": "swp-09-manual-handling",
        "title": "Manual Handling — Pavers, Boulders, Trees", "rev": "1.0",
        "roles": "All field crew",
        "summary": "Lifting technique and limits — 23 kg single-person limit, mechanical assist first.",
        "hazards": [
            ("Musculoskeletal injury — back, shoulder, knee from improper lifting", "HIGH"),
            ("Foot crush from dropped paver, boulder, or root ball", "HIGH"),
            ("Pinch points — fingers between blocks or boulders", "HIGH"),
            ("Struck by rolling boulder or shifting pallet", "HIGH"),
            ("Overexertion and fatigue leading to loss of grip or control", "MEDIUM"),
            ("Cumulative strain from repetitive lifting", "HIGH"),
        ],
        "ppe": [
            "CSA steel-toe boots (mandatory — crush protection)",
            "Work gloves (cut-resistant for pavers; heavy-duty for boulders)",
            "Back brace (optional — not a substitute for proper technique)",
            "Safety glasses",
        ],
        "steps": [
            ("PRE", "Plan the lift: know the weight before picking it up. Pavers: 10–30 kg. Boulders: 30–100+ kg. Trees (25-gal ball): 25–50 kg.", "SINGLE-PERSON LIMIT: 23 kg maximum for a one-person lift. Anything over 23 kg requires 2 persons or mechanical assist."),
            ("PRE", "Clear path: ensure travel path is free of obstacles, uneven ground, and trip hazards.", "Never carry a heavy load up or down a slope without an assistant or mechanical equipment."),
            ("PRE", "Mechanical assist first: whenever possible, use mini excavator, skid steer, or hand truck / pallet jack to move heavy material.", "Manual handling is the last resort — use equipment whenever available and practical."),
            ("1", "Position feet shoulder-width apart, close to the load. Squat — do not bend at the waist.", "The lift power comes from the legs, not the back. Keep chest up, core tight."),
            ("2", "Grip the load firmly. Keep the load close to the body at all times.", "Never reach out with a heavy load — this multiplies force on the spine dramatically."),
            ("3", "Lift by straightening the legs. Keep back straight throughout.", "If back starts to round — stop. Set the load down and re-assess."),
            ("4", "To change direction: move your feet — do not twist your spine while holding a load.", "Twisting under load is the leading cause of serious back injuries in landscaping."),
            ("5", "Two-person lifts: designate one leader. Both lift and lower on the leader's count.", "'Ready? One, two, three — lift.' Move at the same pace."),
            ("6", "Boulders: roll rather than carry whenever possible. Use pry bars and rollers.", "Never place hands or feet under a rolling boulder. Always have a clear escape route."),
            ("7", "Pavers: carry maximum 2 pavers at a time (or per supervisor direction based on size/weight).", "Set pavers down by squatting — do not drop them."),
            ("8", "Take rest breaks every 30 minutes during heavy or repetitive lifting. Report pain immediately.", "Musculoskeletal pain is an early warning sign. Report it — do not work through it."),
        ],
        "emergency": [
            "BACK INJURY / STRAIN: Stop work. Do not attempt to continue lifting. Notify supervisor. Seek medical attention for any persistent pain.",
            "CRUSH INJURY (foot, hand): Apply first aid. Call 911 for serious injuries. Any MSI (musculoskeletal injury) must be documented on the FHSP and reported to the H&S Officer.",
        ],
    },
    {
        "sort": 10, "code": "SWP-10", "slug": "swp-10-mowing",
        "title": "Mowing — Commercial Rider and Walk-Behind", "rev": "1.0",
        "roles": "Maintenance crew",
        "summary": "Mowing — thrown objects, blade safety, slope rollover and bystander zones.",
        "hazards": [
            ("Thrown objects (rocks, debris) — eye, face, body injury", "HIGH"),
            ("Blade contact — fingers, feet", "HIGH"),
            ("Mower rollover on slope (rider mower)", "HIGH"),
            ("Pedestrian / bystander struck by thrown object", "HIGH"),
            ("Noise-induced hearing loss", "MEDIUM"),
            ("Heat stress during extended summer operation", "MEDIUM"),
            ("Carbon monoxide — gasoline mowers in enclosed / partially enclosed areas", "HIGH"),
            ("Vibration — walk-behind, extended use", "MEDIUM"),
        ],
        "ppe": [
            "CSA steel-toe boots",
            "Safety glasses (mandatory — no exceptions)",
            "Hearing protection (mandatory during operation)",
            "Long pants and long sleeves (leg protection from thrown objects)",
            "Hi-visibility vest on commercial/public sites",
            "Sunscreen SPF 30+ and hat for extended outdoor operation",
        ],
        "steps": [
            ("PRE", "Walk the mowing area before starting. Remove all debris: rocks, sticks, wire, cans, bottles.", "Any object in the mow path is a projectile. Thrown objects can travel 50+ metres."),
            ("PRE", "Identify and flag hazards: sprinkler heads, curb edges, tree roots, steep slopes.", "Slopes over 15° should not be mowed with a rider mower. Use walk-behind or string trimmer instead."),
            ("PRE", "Confirm there are no pedestrians, children, or bystanders within 15 m of the mowing area before starting.", "Stop mowing if any person enters the zone. Resume only when they have left."),
            ("PRE", "Complete Equipment Pre-Start Inspection: blade condition, deck guards, fuel, oil, tyres, seatbelt (rider).", "Never operate a mower with missing or damaged blade guards / discharge chutes."),
            ("1", "Start mower in open area with blade disengaged. Engage blade only when ready to mow.", "Never start a mower with the blade engaged."),
            ("2", "Mow parallel to slopes on walk-behind mowers. Mow up-and-down slopes on rider mowers.", "Never mow across a steep slope with a rider mower — rollover risk."),
            ("3", "Keep hands and feet away from the blade deck at all times during operation.", "Never reach under a running deck — even when stopped, the blade may still be spinning."),
            ("4", "To clear a clog: STOP engine, wait for blade to stop completely, then clear by hand.", "This step cannot be skipped. Engagement while clearing is the #1 cause of mower hand amputations."),
            ("5", "On rider mower: seatbelt on at all times. If mower tips, stay in seat — ROPS protects you.", "Jumping from a tipping rider mower places you in the blade path."),
            ("6", "Maintain at least 1 m from curbs, walls, and hard surfaces to contain debris.", "Discharge chute must point away from public, roads, and parked vehicles."),
            ("7", "At end of shift: disengage blade, lower deck, shut off fuel valve (gasoline mowers), clean mower.", "Clean deck of clippings and debris — built-up material is a fire hazard."),
        ],
        "emergency": [
            "BLADE CONTACT / LACERATION: Stop mower. Apply direct pressure. Call 911 for serious injury.",
            "ROLLOVER: Stay in cab if possible. Call 911. Notify supervisor and WorkSafeBC 1-888-621-7233.",
            "BYSTANDER STRUCK BY OBJECT: Stop mowing. Assess injury. Call 911. Notify supervisor.",
        ],
    },
    {
        "sort": 11, "code": "SWP-11", "slug": "swp-11-string-trimmer-brushcutter",
        "title": "String Trimmer / Brushcutter Operation", "rev": "1.0",
        "roles": "All field crew",
        "summary": "Trimmer and brushcutter — guards, exclusion zones, vibration and refuelling.",
        "hazards": [
            ("Eye / face injury from thrown debris", "HIGH"),
            ("Leg / foot injury from blade (brushcutter)", "HIGH"),
            ("Hearing damage from sustained noise", "MEDIUM"),
            ("Hand-arm vibration from extended use", "MEDIUM"),
            ("Bystander struck by thrown object", "HIGH"),
            ("Entanglement of clothing or hair in rotating head", "MEDIUM"),
            ("Fuel spill / fire risk — gasoline units", "MEDIUM"),
        ],
        "ppe": [
            "Safety glasses or face shield (mandatory)",
            "Hearing protection",
            "CSA steel-toe boots",
            "Long pants and long sleeves — leg protection",
            "Work gloves",
            "Hi-visibility vest on public sites",
            "Chaps / leg guards when operating a brushcutter with a blade attachment",
        ],
        "steps": [
            ("PRE", "Inspect trimmer: guard in place, line/blade condition, throttle and kill switch function.", "Do not operate without the line guard. Brushcutter blades must have full blade guard in place."),
            ("PRE", "Inspect the area: remove large debris. Identify hazards (irrigation heads, curbs, rocks).", "Walk the area and flag hazards before starting."),
            ("PRE", "Confirm no bystanders within 15 m. Minimum exclusion zone from public areas.", "Stop and wait if any person approaches the work zone."),
            ("1", "Start engine with trimmer head pointing away from the body and all bystanders.", "Never start with the head near the ground or near a hard surface — debris ejection at start."),
            ("2", "Keep trimmer head below knee height during normal operation.", "Higher sweeps increase thrown object height and range."),
            ("3", "Trim with a smooth sweeping motion. Do not jam the head into hard surfaces.", "Contact with curb, concrete, or gravel throws debris at high velocity."),
            ("4", "Keep a firm two-hand grip at all times. Body positioned to the side of the trimmer arc.", "Never position your body or anyone else's in the plane of rotation."),
            ("5", "Vibration limit: maximum 2 hours continuous, then 10-minute break.", "Report numbness, tingling, or white fingers to supervisor — early sign of HAVS."),
            ("6", "Fuel up with engine OFF and cool. No smoking within 3 m of fuel.", "Allow engine to cool before refuelling. Wipe up any spills before starting."),
            ("7", "At end of use: engage kill switch, allow head to stop, engage safety guard.", "Never rest a running trimmer against a vehicle or structure."),
        ],
        "emergency": [
            "EYE INJURY: Do not rub. Cover loosely. Call 911. Do not remove embedded objects.",
            "LACERATION: Stop tool. Apply direct pressure. Call 911 for serious injury.",
            "BYSTANDER INJURY: Stop immediately. Call 911. Notify supervisor.",
        ],
    },
    {
        "sort": 12, "code": "SWP-12", "slug": "swp-12-chainsaw-hand-saw",
        "title": "Chainsaw / Hand Saw Operation", "rev": "1.0",
        "roles": "Qualified workers only — must have completed chainsaw safety training",
        "summary": "Chainsaw work — kickback control, felling, exclusion zones, qualified operators only.",
        "hazards": [
            ("Kickback — chain saw contacts hard object, blade snaps back to operator", "HIGH"),
            ("Laceration / amputation from chain contact", "HIGH"),
            ("Struck by falling limb or tree", "HIGH"),
            ("Noise-induced hearing loss", "MEDIUM"),
            ("Vibration — hand-arm vibration from extended chainsaw use", "MEDIUM"),
            ("Spring-back from cut branches under tension", "HIGH"),
            ("Fuel spill / fire from gasoline saw", "MEDIUM"),
            ("Eye injury from sawdust and wood chips", "MEDIUM"),
        ],
        "ppe": [
            "CSA steel-toe boots (chainsaw-cut resistant preferred)",
            "Chainsaw chaps / cut-resistant leg protection (mandatory)",
            "Hard hat (CSA Z94.1, Class E) — mandatory when cutting overhead",
            "Face shield over safety glasses",
            "Hearing protection",
            "Cut-resistant work gloves",
            "Hi-visibility vest",
        ],
        "steps": [
            ("PRE", "Only qualified workers (chainsaw safety trained) may operate a chainsaw.", "Confirm training on file before assigning any worker to chainsaw tasks."),
            ("PRE", "Inspect chainsaw: chain tension, sharpness, chain brake, throttle lock, anti-vibration mounts, fuel.", "A dull chain increases kickback risk. A loose chain is a thrown-chain hazard."),
            ("PRE", "Assess the work: identify all pinch points in the wood, direction of fall, escape routes, overhead hazards.", "Plan the cut before making it. Brief all crew on the fall zone and exclusion area."),
            ("PRE", "Establish exclusion zone: minimum 2× the tree height radius. No unauthorized persons in zone.", "The fall zone extends in all directions the tree could fall, not just the intended direction."),
            ("1", "Start chainsaw on the ground or in a secure position — never drop-start.", "Grip saw firmly. Chain brake on during start. Move at least 3 m from fueling area."),
            ("2", "Make all cuts below shoulder height whenever possible.", "Never cut overhead. Use a pole saw or ATWS-trained arborist for overhead work."),
            ("3", "Use the lower portion of the bar for cuts (reduces kickback). Be aware of the kickback zone (tip of bar).", "Never let the tip of the bar contact any surface or material — this causes kickback."),
            ("4", "Before cutting a limb: assess tension. Determine if it will spring up, spring down, or stay stable.", "Cut from the tension side first (partial cut), then finish from the compression side. Prevents pinching."),
            ("5", "When felling a tree: make undercut first (notch toward the fall direction), then back cut.", "Leave a hinge — never cut all the way through. The hinge controls the direction of fall."),
            ("6", "Call 'TIMBER' loudly before a tree falls. Move along the planned escape route immediately.", "Escape route is 45° back and away from the intended fall direction."),
            ("7", "At rest or when moving: chain brake ON. Never walk with a running saw — always engage chain brake.", "Never hand a running chainsaw to another person."),
            ("8", "Vibration limit: maximum 2 hours continuous. Take breaks and report any hand/arm symptoms.", "HAVS (Hand-Arm Vibration Syndrome) is a serious long-term condition."),
        ],
        "emergency": [
            "CHAINSAW LACERATION / AMPUTATION: Call 911 immediately. Apply direct pressure. For amputated parts: place in clean cloth, cool (NOT frozen), bring to hospital.",
            "STRUCK BY FALLING LIMB: Call 911. Do not move injured person if spinal injury suspected.",
            "KICKBACK EVENT (even if no injury): Stop work. Report to supervisor. Inspect saw before resuming.",
        ],
    },
    {
        "sort": 13, "code": "SWP-13", "slug": "swp-13-roadside-traffic-work",
        "title": "Roadside / Traffic-Exposed Work", "rev": "1.0",
        "roles": "All crew working in or adjacent to traffic",
        "summary": "Traffic-exposed work — TCP, hi-vis, device setup order and struck-by controls.",
        "hazards": [
            ("Worker struck by vehicle — fatal / serious injury", "HIGH"),
            ("Equipment struck by vehicle", "HIGH"),
            ("Driver distraction near work zone", "HIGH"),
            ("Workers not visible to drivers (low-light, weather, sun glare)", "HIGH"),
            ("Pedestrians entering work zone", "MEDIUM"),
            ("Traffic control signs/devices removed or knocked down", "MEDIUM"),
        ],
        "ppe": [
            "High-visibility vest (Class 2 minimum — CSA Z96)",
            "CSA steel-toe boots",
            "Hard hat (CSA Z94.1) when working near vehicles or equipment",
            "Safety glasses",
            "Hearing protection during mowing or trimming",
        ],
        "steps": [
            ("PRE", "Confirm a Traffic Control Plan (TCP) is in place and approved by the site supervisor.", "Any work that requires workers to be within 1 m of active traffic lanes requires a TCP. Municipal and MoTI permits may be required."),
            ("PRE", "Confirm a certified Traffic Control Person (TCP) is on site if the work blocks or narrows a lane.", "TCP certification required by WorkSafeBC. All crew review the TCP at morning briefing."),
            ("PRE", "Set up traffic control devices before any crew enters the work zone.", "Sequence: place far-end taper signs first, then advance warning signs, then cones/drums in the work zone."),
            ("PRE", "Confirm all crew are wearing Class 2 hi-visibility vests (or greater).", "No exceptions. All visitors and subcontractors on site must also wear hi-vis."),
            ("1", "Workers always face oncoming traffic when possible.", "Maintain situational awareness of traffic at all times."),
            ("2", "Keep equipment operator exclusion zones enforced within the work zone.", "Equipment and vehicles: confirm with horn before reversing. Use spotters."),
            ("3", "No personal electronic devices (earbuds, headphones, phones) while in the work zone.", "Workers must be able to hear vehicle approach, horn signals, and verbal warnings at all times."),
            ("4", "If a driver enters the work zone: stop work, use hand signals / TCP flagging to direct them out.", "Do not argue with drivers in the work zone. Stay calm. If threatened, call 911."),
            ("5", "At end of day: remove all traffic control devices in reverse order (work zone first, then advance signs).", "Never leave traffic control devices in place overnight unless approved by the TCP plan."),
            ("6", "Report any TCP violation or near-miss to the supervisor immediately.", "All vehicle-worker near-misses are recordable incidents — document on FHSP and report to H&S Officer."),
        ],
        "emergency": [
            "WORKER STRUCK BY VEHICLE: Call 911 immediately. Do not move victim unless in immediate danger. Notify WorkSafeBC 1-888-621-7233 — all vehicle-worker strikes are serious incidents. Preserve scene.",
            "VEHICLE IN WORK ZONE: Signal TCP to stop traffic. Move workers clear. Call 911 if vehicle is out of control.",
        ],
    },
    {
        "sort": 14, "code": "SWP-14", "slug": "swp-14-wildfire-smoke-aqhi",
        "title": "Work in Wildfire Smoke (AQHI Protocol)", "rev": "1.0",
        "roles": "All field crew — applicable during any wildfire smoke event",
        "summary": "AQHI-tiered smoke protocol — respirators, rest breaks and go/no-go thresholds.",
        "hazards": [
            ("Respirable fine particulates (PM2.5) — lung and cardiovascular damage", "HIGH"),
            ("Reduced visibility — trip, fall, equipment hazard", "MEDIUM"),
            ("Heat stress combined with smoke (double physiological burden)", "HIGH"),
            ("Eye, nose, throat irritation impairing worker ability", "MEDIUM"),
            ("Aggravation of pre-existing respiratory or cardiac conditions", "HIGH"),
        ],
        "ppe": [
            "N95 respirator (NIOSH-approved) — available on all crew vehicles at all times during fire season",
            "Safety glasses (smoke irritates eyes — prevents rubbing)",
            "CSA steel-toe boots",
            "Standard field PPE for the task being performed",
        ],
        "steps": [
            ("PRE", "Check the Air Quality Health Index (AQHI) at env.gov.bc.ca before each shift.", "Record the current AQHI value on the FHSP. If AQHI is not available, use the ECCC Weather app."),
            ("1", "AQHI 1–3 (LOW): Normal operations. N95 respirators available but not required.", "Continue work. Monitor AQHI throughout the shift."),
            ("2", "AQHI 4–6 (MODERATE): N95 respirators offered to all workers.", "Workers at higher risk (heart/lung conditions) wear N95. Increase rest breaks by 10%. Ensure hydration."),
            ("3", "AQHI 7–10 (HIGH): N95 respirators mandatory for all outdoor workers.", "Increase rest breaks by 25%. Evaluate whether heavy physical work should continue. Supervisor to check in with crew every 30 minutes."),
            ("4", "AQHI > 10 (VERY HIGH): Contact H&S Officer and Owner for go/no-go decision before proceeding.", "Suspend heavy outdoor work. Relocate to enclosed vehicles/structures if possible. Consider suspending the shift."),
            ("5", "N95 FIT: Conduct user seal check before each use (positive pressure / negative pressure test).", "A poorly fitted N95 provides minimal protection. Workers with beards cannot achieve a proper seal — discuss alternatives with supervisor."),
            ("6", "Monitor workers throughout the shift for smoke-related symptoms: headache, nausea, dizziness, shortness of breath, chest tightness.", "Any symptomatic worker must stop work immediately and move to a clean-air environment."),
            ("7", "At end of shift: record AQHI value(s), PPE used, and any symptoms on the FHSP.", "This record is important for long-term occupational health tracking."),
        ],
        "emergency": [
            "RESPIRATORY DISTRESS / CHEST PAIN / DIZZINESS: Stop work immediately. Move to clean air (vehicle cab with windows up and HVAC recirculating). Call 911 if symptoms are severe or do not improve within 10 minutes. All serious respiratory events during smoke conditions are reportable to WorkSafeBC.",
        ],
    },
    {
        "sort": 15, "code": "SWP-15", "slug": "swp-15-heat-stress-prevention",
        "title": "Heat Stress Prevention", "rev": "1.0",
        "roles": "All field crew — applicable during hot weather operations",
        "summary": "Hot-weather work — Humidex-tiered rest/water schedule, acclimatization and heat-illness response.",
        "hazards": [
            ("Heat exhaustion — excessive sweating, nausea, weakness, pale skin", "MEDIUM"),
            ("Heat stroke — hot dry skin, confusion, loss of consciousness — LIFE-THREATENING", "HIGH"),
            ("Dehydration impairing judgement and physical performance", "MEDIUM"),
            ("Sunburn and UV skin damage", "LOW"),
            ("Aggravated heat risk when working in wildfire smoke (see SWP-14)", "HIGH"),
        ],
        "ppe": [
            "Sunscreen SPF 30+ (reapply every 2 hours)",
            "Wide-brim hat or hard hat with sun brim",
            "Light-coloured, lightweight, breathable long-sleeve shirt",
            "Safety glasses (also provides UV protection)",
            "CSA steel-toe boots and full task PPE (cannot be reduced for heat — manage heat by other means)",
        ],
        "steps": [
            ("PRE", "Check forecast temperature and Humidex before each shift. Record on FHSP.", "Humidex ≥ 35: heightened monitoring required. Humidex ≥ 40: supervisor must assess whether heavy work should be modified or suspended."),
            ("PRE", "Confirm adequate cool water is on site: minimum 250 mL per worker per hour, or 1 L per hour in extreme heat.", "Water must be cool and accessible — not stored in a hot vehicle."),
            ("PRE", "Identify a shaded rest area. If no natural shade exists, set up a canopy or use vehicle shade.", "Workers must be able to rest out of direct sun."),
            ("1", "Hydrate before starting work. Continue drinking water throughout the shift — do not wait until thirsty.", "Thirst is a late sign of dehydration. Drink regularly on a schedule, not on demand."),
            ("2", "Acclimatization for new workers: during heat events, limit new workers to 50% physical workload on Day 1, increasing over 5–7 days.", "Unacclimatized workers are at high risk of heat illness. Gradual exposure is critical."),
            ("3", "Rest schedule during heat events: Humidex 28–31 normal work/rest; Humidex 32–35 10 min rest per hour; Humidex 36–40 15 min rest per 45 min; Humidex > 40 15 min rest per 30 min.", "Rest in shade. Supervisors enforce rest schedule — workers in heat may not recognize their own deterioration."),
            ("4", "Schedule heavy tasks (digging, compaction, block-laying) for early morning. Lighter tasks in peak heat (12–4 pm).", "Peak UV and heat: 11 am – 4 pm. Shift heavy work earlier whenever possible."),
            ("5", "Supervisors monitor crew throughout the shift for signs of heat illness.", "Signs to watch for: excessive sweating, confusion, slurred speech, pale/clammy skin, muscle cramps, nausea."),
            ("6", "HEAT EXHAUSTION: move worker to shade/cool area. Remove excess clothing. Cool with wet cloths or cool water. Give cool water to drink if conscious.", "Symptoms: heavy sweating, weakness, nausea, headache, cool/pale/moist skin. If not improving in 15 min, call 911."),
            ("7", "HEAT STROKE: CALL 911 IMMEDIATELY.", "Symptoms: hot/red/dry skin (may not be sweating), rapid pulse, confusion, loss of consciousness. This is a medical emergency. Cool the person with any means available while waiting for paramedics."),
        ],
        "emergency": [
            "HEAT STROKE — CALL 911 IMMEDIATELY. Do not wait and see. Move worker to shade. Apply cool water to skin. Fan them. Give cool water only if conscious and able to swallow.",
            "HEAT EXHAUSTION: move to shade, cool down, hydrate. Call 911 if not improving within 15 minutes or if condition worsens. All heat illness incidents are reportable to WorkSafeBC.",
        ],
    },
]


async def seed_safety_swps_if_missing(db):
    """Insert any SWP whose slug is not already in safety_documents. Never updates."""
    rows = await db._q("SELECT slug FROM safety_documents", [])
    have = {r["slug"] for r in (rows or [])}
    inserted = 0
    for swp in SWPS:
        if swp["slug"] in have:
            continue
        body = _render(swp)
        await db._x(
            """INSERT INTO safety_documents
               (slug, title, category, layer, code, summary, html, plain_text, version,
                status, field_visible, sort_order, updated_by)
               VALUES (?, ?, 'swp', 2, ?, ?, ?, ?, ?, 'published', 1, ?, 'seed')""",
            [swp["slug"], swp["title"], swp["code"], swp["summary"],
             body, _plain(body), swp["rev"], swp["sort"]])
        inserted += 1
    if inserted:
        logger.info("Seeded %d Safe Work Procedures into the Safety Program library", inserted)
    return inserted
