"""
Starter load for the company Safety & PPE Policy (SAF-001 v2.2) — Layer 1 of the Safety
Management System. Content transcribed faithfully from the authoritative
Darios_Safety_PPE_Policy_v2.2.pdf held in Company Documents; the Section-4 PPE-by-task,
AQHI, non-compliance and version tables were extracted cell-by-cell so pairings are exact.

Insert-if-missing by slug, never updated here — once it is in the table the admin page
(/ops/safety-program) owns it, so staff edits / new versions are safe from deploys.
"""
import logging

from app.api.safety_seed import _plain

logger = logging.getLogger(__name__)

SLUG = "safety-ppe-policy-saf-001"


def _esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ── Section 4 — PPE Requirements by Task (task, PPE, notes) ───────────────────────
PPE_ROWS = [
    ['General Field Work (all tasks)', 'Safety footwear (CSA-approved, protective toe — steel or composite, worker-supplied), Sun-protective clothing or sunscreen SPF 30+', 'Baseline requirement — no exceptions.'],
    ['String Trimmer / Edger Operation', 'Safety glasses or face shield, Hearing protection (>85 dB), Gloves', 'Flying debris risk; confirm hearing protection rating'],
    ['Ride-On Mower Operation', 'Hearing protection, Eye protection (dusty conditions), ROPS seatbelt fastened', 'Ensure rollover protection structure is in place'],
    ['Blower Operation', 'Hearing protection, Dust mask (N95) in dry/dusty conditions', 'Extended use — check hearing protection fit'],
    ['Hand Tool Use (shovels, rakes, etc.)', 'Work gloves, Safety footwear', 'Inspect tool handles for splinters/cracks before use'],
    ['Pesticide / Herbicide Application', 'Chemical-resistant gloves, Safety glasses or goggles, Respirator (per SDS requirement), Chemical-resistant apron or coveralls, Rubber boots', 'Applicator must hold valid Pesticide Applicator Certificate; SDS must be on site'],
    ['Fertilizer Application', 'Work gloves, Eye protection', 'Review SDS for product-specific requirements'],
    ['Roadside / Traffic Exposure Work', 'High-visibility vest (Class 2 minimum), Hard hat if overhead hazards present', 'Traffic Control Plan required; follow BC Ministry of Transportation standards'],
    ['Working in Wooded / Brushy Areas (Tick Risk)', 'Long-sleeved shirt and long pants (light colours preferred), Tick repellent (DEET or permethrin-treated clothing), Gaiters or pants tucked into socks', 'See Section 9 — Tick Safety Protocol for post-work inspection procedures'],
    ['Heat-Exposed Work (Summer Field Operations)', 'Lightweight breathable clothing, Wide-brim hat, Sunscreen SPF 30+', 'See Section 8 — Heat Stress Protocol'],
    ['Heavy Lifting (>23 kg)', 'Back support if recommended by health professional, Gloves for grip', 'Use team lift or mechanical aids where possible; train workers on proper technique'],
    ['Irrigation Installation & Repair (Hand Digging / Light Trenching)', 'Work gloves, Safety glasses, Steel-toed boots, High-visibility vest if working near vehicles or roadways', 'Locate underground utilities through BC 1 Call before any digging; trenches deeper than 1.2 m require shoring or sloping per WorkSafeBC. See Section 10.'],
    ['Powered Trenching (Walk-Behind Trencher / Mini Excavator for Irrigation)', 'Hard hat, Safety glasses, Hearing protection, Steel-toed boots, High-visibility vest, Snug-fitting clothing (no loose sleeves, drawstrings, or jewellery)', 'Operator must be trained on the specific machine; locate utilities first; spotter required when other workers are within the swing or travel path. See Sections 10 and 11.'],
    ['Irrigation Blow-Out (Compressed Air Winterization)', 'Safety glasses with side shields or full-face shield, Hearing protection (compressors typically >90 dB), Work gloves, Steel-toed boots', 'Never exceed 50 PSI for poly pipe / 80 PSI for PVC. Never aim hose at people. Bleed pressure before disconnecting any fitting. See Section 10.'],
    ['Pressurization & Pressure Testing of Irrigation Lines', 'Safety glasses, Work gloves, Steel-toed boots', 'Stand clear during initial pressurization; never tighten or disassemble fittings under pressure; high-pressure water can cause injection injuries.'],
    ['Skid Steer / Compact Track Loader / Mini Excavator Operation', 'Seatbelt fastened at all times in cab, Hard hat (when out of cab or in proximity), Hearing protection, High-visibility vest, Steel-toed boots', 'Trained operators only; one person in cab; spotter required when working near other workers; do not exceed slope limits in operator manual. See Section 11.'],
    ['Plate Compactor / Jumping Jack Tamper', 'Hearing protection, Safety glasses, Anti-vibration gloves, Steel-toed boots', 'Hand-arm vibration limits apply — rotate operators on extended runs; keep feet clear of plate; refuel with engine off.'],
    ['Concrete / Stone / Paver Cutting (Wet Saw, Cut-Off Saw, Angle Grinder)', 'P100 or N95 respirator (silica), Safety glasses or face shield, Hearing protection, Cut-resistant gloves, Steel-toed boots, Long sleeves', 'Wet-cutting required where feasible. Silica is a designated substance under WorkSafeBC — an Exposure Control Plan is required for any dry cutting. See Section 11.'],
    ['Hand-Held Power Tools (Rotary Hammer, Recip Saw, Circular Saw, Drill)', 'Safety glasses, Hearing protection (tools rated >85 dB), Work gloves, Steel-toed boots', 'Inspect cords, plugs, and batteries before use. GFCI required for outdoor 120V. Never disable guards or safety switches.'],
    ['Pressure Washer Operation', 'Safety glasses or full-face shield, Hearing protection, Waterproof steel-toed boots, Work gloves, Long pants', 'Never aim wand at people, animals, or yourself. High-pressure water can cause injection injuries — seek immediate medical care if struck. Two-handed grip required.'],
    ['Generator Operation & Refuelling', 'Hearing protection, Work gloves, Safety glasses (refuelling)', 'Operate outdoors only — never inside buildings, sheds, or enclosed trailers (carbon monoxide hazard). Shut off and allow to cool before refuelling.'],
    ['Work in Occupied / Public Commercial Areas (apartment & strata buildings, busy sidewalks, parking lots)', 'High-visibility vest (Class 2 minimum), Safety glasses, Hearing protection per tool in use, Steel-toed boots, Work-zone signage / cones / barricades', 'Set up cones/signage and keep pedestrians clear of equipment; direct debris away from people and property; keep entrances, exits, and fire lanes clear. See Section 13.'],
    ['Outdoor Work During Smoke Advisory (AQHI 7+)', 'N95 respirator (mandatory), Lightweight breathable clothing, Eye protection if smoke causes irritation', 'Check AQHI before each shift at env.gov.bc.ca. Reduce heavy exertion for vulnerable workers. See Section 12 — Wildfire Smoke Protocol'],
]

AQHI_ROWS = [
    ['1–3', 'Low', 'Blue', 'Normal outdoor work. No restrictions.'],
    ['4–6', 'Moderate', 'Yellow', 'Monitor workers for symptoms. Consider N95 respirators for vulnerable workers (asthma, heart conditions). Increase paid rest breaks.'],
    ['7–10', 'High', 'Orange', 'N95 respirators required for all workers doing moderate to heavy outdoor work. Reduce strenuous tasks. Assign vulnerable workers to lighter-duty tasks. Watch for symptoms (see below).'],
    ['10+', 'Very High / Extreme', 'Red/Maroon', 'Stop or significantly reduce heavy outdoor work. N95 mandatory for any outdoor work. Assign vulnerable workers to lighter-duty tasks and increase paid rest breaks. Consider rescheduling non-urgent work. Contact WorkSafeBC if prolonged exposure cannot be avoided.'],
]

NONCOMPLIANCE_ROWS = [
    ['1st occurrence', 'Verbal warning and retraining', 'Supervisor note in worker file'],
    ['2nd occurrence', 'Written warning', 'Signed written warning on file'],
    ['3rd occurrence', 'Final written warning; temporary removal from site', 'HR review; documented meeting'],
    ['Refusal to comply / serious risk', 'Suspension or termination', 'Full incident documentation'],
]

VERSION_ROWS = [
    ['1.0', '—', '—', 'Initial policy. Tree chipper excluded (not arborist operations). Tick safety protocol added.'],
    ['1.1', '—', '—', 'Added irrigation safety procedures (Section 10) covering BC 1 Call utility location, pressurization, compressed-air blow-outs (50 PSI poly / 80 PSI PVC), electrical components, and valve boxes. Added landscape construction equipment safety (Section 11). Added 10 new task rows to the PPE Requirements table.'],
    ['1.2', '—', '—', 'Added Working Safely in Commercial and Public Areas (now Section 13). Added one task row to the PPE Requirements table. Renumbered former Sections 12–14. Updated Section 6 footwear requirements: Construction requires a protective toe (steel or composite) and minimum 6-inch boot height; Maintenance & Irrigation may use CSA-approved composite-toe boots.'],
    ['2.2', 'August 11, 2026', 'Paul Winckers', 'Added Section 12 — Wildfire Smoke Protocol (AQHI thresholds, N95 requirements, vulnerable workers, paid rest breaks, operational controls). Added wildfire smoke PPE row to task table. Sections renumbered.'],
]


def _table(cols: list[str], rows: list[list[str]]) -> str:
    out = ["<table><thead><tr>" + "".join(f"<th>{_esc(c)}</th>" for c in cols) + "</tr></thead><tbody>"]
    for r in rows:
        out.append("<tr>" + "".join(f"<td>{_esc(c)}</td>" for c in r) + "</tr>")
    out.append("</tbody></table>")
    return "".join(out)


def _ul(items: list[str]) -> str:
    return "<ul>" + "".join(f"<li>{i}</li>" for i in items) + "</ul>"


def _build_html() -> str:
    h: list[str] = []
    h.append('<p class="lead"><strong>Safety &amp; Personal Protective Equipment (PPE) Policy</strong> '
             '&mdash; Policy No. SAF-001 &middot; Version 2.2 &middot; Effective July 26, 2026 &middot; '
             'Approved by Paul Winckers, GM.</p>')
    h.append("<p>Dario's Landscape Services Ltd. &middot; 3300 Sexsmith Road, Kelowna, BC.</p>")

    h.append("<h2>1. Purpose</h2>")
    h.append("<p>This policy establishes minimum safety and PPE standards for all employees of Dario's "
             "Landscape Services engaged in landscaping operations in British Columbia. It is designed to "
             "meet or exceed the requirements of the Workers Compensation Act and the OHS Regulation "
             "(WorkSafeBC), and to protect the health and safety of every worker.</p>")

    h.append("<h2>2. Scope</h2>")
    h.append("<p>This policy applies to all field employees, supervisors, subcontractors, and any other "
             "workers performing duties on behalf of Dario's Landscape Services, including maintenance, "
             "installation, grounds care, roadside work, and chemical application.</p>")

    h.append("<h2>3. Responsibilities</h2>")
    h.append("<h3>Employer / Management</h3>")
    h.append(_ul([
        "Provide all required PPE at no cost to workers, with the exception of safety footwear (see "
        "Section 6 &mdash; Safety Footwear) and shorts/pants/shirts outside of the regularly provided company ware.",
        "Ensure PPE is properly maintained, inspected, and replaced as needed.",
        "Provide training on the correct use and care of PPE.",
        "Enforce this policy consistently across all work sites.",
        "Review and update this policy at least annually or following any significant incident.",
    ]))
    h.append("<h3>Supervisors</h3>")
    h.append(_ul([
        "Conduct daily pre-work briefings covering site-specific hazards.",
        "Confirm all workers are wearing required PPE before work begins.",
        "Remove workers from the task if PPE is not being worn correctly.",
        "Document and report any non-compliance or PPE-related incidents.",
    ]))
    h.append("<h3>Workers</h3>")
    h.append(_ul([
        "Inspect PPE before each use and report damage or wear.",
        "Wear all required PPE for the task being performed.",
        "Never modify or disable PPE.",
        "Report fit or comfort issues to a supervisor so alternatives can be sourced.",
        "Participate in safety training and follow all safe work procedures.",
    ]))

    h.append("<h2>4. PPE Requirements by Task</h2>")
    h.append("<p>The following table outlines minimum PPE requirements. Supervisors may require additional "
             "PPE based on site-specific hazard assessment.</p>")
    h.append(_table(["Task / Hazard", "Required PPE", "Notes"], PPE_ROWS))

    h.append("<h2>5. PPE Inspection and Replacement</h2>")
    h.append("<p>All PPE must be inspected before each use. Workers must report any defect, damage, or "
             "deterioration to their supervisor immediately. PPE showing signs of wear, chemical exposure, "
             "impact damage, or improper fit must be taken out of service and replaced at no cost to the "
             "worker. Supervisors are responsible for maintaining an adequate stock of PPE at the shop and "
             "in company vehicles.</p>")

    h.append("<h2>6. Safety Footwear</h2>")
    h.append("<p>CSA-approved safety footwear with a protective toe is required for all field work. Toe-cap "
             "type and minimum boot height vary by division (see below). In recognition of the personal "
             "nature of footwear, Dario's Landscape Services does not supply boots directly.</p>")
    h.append(_ul([
        "Workers must purchase CSA-approved, Grade 1 (green triangle) or Grade 2 (yellow triangle) safety "
        "footwear appropriate to their tasks.",
        "<strong>Construction division:</strong> Boots must have a protective toe cap (steel or composite) "
        "and be at least 6 inches (15 cm) high to support the ankle and protect against the hazards of "
        "hardscape, grading, and demolition work.",
        "<strong>Maintenance &amp; Irrigation division:</strong> Composite-toe boots may be worn in place "
        "of steel toe, provided they are CSA-approved. Boot height may be chosen to suit the task and worker comfort.",
        "Supervisors must confirm that workers' footwear meets CSA standards before authorizing work. "
        "Workers wearing non-compliant footwear will not be permitted on site until compliant boots are worn.",
        "Workers who cannot afford footwear before their first day should speak with their supervisor "
        "&mdash; the company will work to find an interim solution.",
    ]))

    h.append("<h2>7. WHMIS and Chemical Safety</h2>")
    h.append("<p>All workers who handle or may be exposed to hazardous products must complete WHMIS 2015 "
             "training before starting work with those products. Safety Data Sheets (SDS) for all chemicals "
             "in use must be accessible on every job site where those chemicals are present. Workers must "
             "review the SDS for any new product before using it. Chemical storage in vehicles must comply "
             "with Transportation of Dangerous Goods requirements where applicable.</p>")

    h.append("<h2>8. Heat Stress Protocol</h2>")
    h.append("<p>During periods of high temperature or humidity, supervisors must monitor workers for signs "
             "of heat-related illness. The following controls apply:</p>")
    h.append(_ul([
        "Workers must have access to cool drinking water at all times &mdash; minimum 250 mL per hour "
        "during hot conditions.",
        "Mandatory shade breaks of at least 10 minutes per hour when the humidex reaches 35&deg;C or above.",
        "Work schedules may be adjusted to complete heavy tasks in cooler morning hours.",
        "Signs of heat exhaustion (dizziness, nausea, heavy sweating, weakness) must be reported immediately "
        "and the affected worker removed from the heat.",
        "<strong>Signs of heat stroke (confusion, lack of sweating, loss of consciousness) are a medical "
        "emergency &mdash; call 911.</strong>",
    ]))

    h.append("<h2>9. Tick Safety Protocol</h2>")
    h.append("<p>Workers in BC are at risk of exposure to ticks, particularly in wooded, brushy, grassy, or "
             "overgrown areas. Ticks can transmit Lyme disease and other tick-borne illnesses. The following "
             "precautions are required whenever workers are in or near high-risk environments.</p>")
    h.append("<h3>Prevention</h3>")
    h.append(_ul([
        "Wear light-coloured long-sleeved shirts and long pants &mdash; light colours make ticks easier to spot.",
        "Tuck pants into socks or boots when working in brushy or long-grass areas.",
        "Apply tick repellent containing DEET (at least 20%) to exposed skin and clothing before entering "
        "tick habitat. Permethrin-treated clothing is a highly effective option for field crews.",
        "Stay on cleared paths where possible; avoid brushing against vegetation unnecessarily.",
    ]))
    h.append("<h3>Post-Work Tick Check (Required Daily)</h3>")
    h.append("<p>All workers must perform a full-body tick check at the end of each workday if they have "
             "been in tick habitat. Key areas to check include:</p>")
    h.append(_ul([
        "Scalp, behind ears, and hairline",
        "Back of neck and between shoulder blades",
        "Underarms and groin area",
        "Behind knees and between toes",
    ]))
    h.append("<p>Workers should also check clothing and gear before getting into vehicles. Showering within "
             "two hours of coming indoors can help remove unattached ticks.</p>")
    h.append("<h3>If a Tick is Found Attached</h3>")
    h.append(_ul([
        "Remove the tick promptly using fine-tipped tweezers. Grasp as close to the skin as possible and "
        "pull upward with steady pressure &mdash; do not twist or jerk.",
        "Do not crush, burn, or apply substances to the tick.",
        "Clean the bite area with rubbing alcohol or soap and water.",
        "Record the date and location of the bite and save the tick in a sealed container or bag for "
        "identification if possible.",
        "Report the tick bite to your supervisor and seek medical advice, particularly if a rash "
        "(bull's-eye pattern), fever, fatigue, or joint pain develops within 3&ndash;30 days.",
    ]))
    h.append("<h3>Employer Responsibilities</h3>")
    h.append(_ul([
        "Provide tick repellent and ensure it is available on every crew vehicle.",
        "Train all field workers on tick awareness and removal before the start of the season.",
        "Post tick safety information in break areas and vehicles.",
    ]))

    h.append("<h2>10. Irrigation Safety Protocol</h2>")
    h.append("<p>Irrigation work involves underground utilities, pressurized water and air, and electrical "
             "components. The following procedures apply to all irrigation installation, repair, "
             "winterization, and spring start-up work.</p>")
    h.append("<h3>Underground Utility Location (Before You Dig)</h3>")
    h.append(_ul([
        "BC 1 Call must be contacted at least three full business days before any digging &mdash; phone "
        "1-800-474-6886 or visit bc1c.ca. The service is free.",
        "Daylight (hand-expose) all marked utilities before any mechanical excavation crosses or runs "
        "parallel to them.",
        "Tolerance zone: stay at least 1 m clear of any marked utility until it has been visually confirmed "
        "by hand-exposure.",
        "Trenches deeper than 1.2 m must be sloped, benched, or shored per WorkSafeBC OHS Regulation Part 20. "
        "Spoil piles must be kept at least 0.6 m from the trench edge.",
        "Any utility damage must be reported immediately, the site secured, and the utility owner contacted.",
    ]))
    h.append("<h3>Pressurization and Pressure Testing</h3>")
    h.append(_ul([
        "Confirm all fittings are torqued and glue joints have cured to the manufacturer's specification "
        "before applying pressure.",
        "Stand clear of any cap, plug, or end fitting during initial pressurization &mdash; failures eject "
        "parts at high velocity.",
        "Pressurize gradually. Bring the system to operating pressure in stages and inspect for leaks at each stage.",
        "Never tighten, adjust, or disassemble a fitting while the line is under pressure. Bleed pressure first.",
        "High-pressure water can cause injection injuries even from pinhole leaks. Treat any water-injection "
        "wound as a medical emergency, even if it looks minor.",
    ]))
    h.append("<h3>Compressed-Air Blow-Outs (Winterization)</h3>")
    h.append("<p>Blow-outs are the highest-risk task in irrigation. The following rules are mandatory on "
             "every winterization job:</p>")
    h.append(_ul([
        "Match air pressure to pipe rating: maximum 50 PSI for poly pipe, maximum 80 PSI for PVC. Never "
        "exceed the lowest-rated component in the system.",
        "The compressor must have a properly rated regulator and a pressure relief valve. Confirm both are "
        "functioning before starting.",
        "Inspect the air hose, fittings, and quick-couplers for cracks, abrasion, or worn ferrules before "
        "each use. Replace any damaged component.",
        "Never aim a charged air hose at any person, including yourself. Compressed air at these pressures "
        "can cause eye injuries, embolism through the skin, and ruptured eardrums.",
        "Open one zone at a time and let air flow through that zone for the manufacturer-specified duration "
        "before moving on. Do not run the compressor against a closed system.",
        "Bleed pressure from the line before disconnecting any hose, fitting, or quick-coupler.",
        "Hearing protection is required within 3 m of an operating compressor.",
        "Pop-up sprinkler heads can eject debris at high velocity during blow-outs. Keep co-workers, clients, "
        "and pets clear of the spray pattern of any active zone.",
    ]))
    h.append("<h3>Electrical Components (Controllers, Valves, Solenoids)</h3>")
    h.append(_ul([
        "Disconnect power at the controller before working on any wiring. 24V solenoid wiring is generally "
        "low-risk but must still be confirmed de-energized.",
        "Any work on 120V or 240V controller wiring must be performed by a qualified electrician.",
        "Outdoor 120V circuits must be GFCI-protected. Test the GFCI before each use.",
        "Avoid electrical work in wet conditions or while standing in water. If conditions are wet, secure "
        "the area and return when dry or use battery-powered tools only.",
    ]))
    h.append("<h3>Valve Boxes and Vaults</h3>")
    h.append(_ul([
        "Open valve box lids carefully &mdash; boxes commonly harbour wasps, spiders, and small animals.",
        "Never reach into a valve box without first looking inside. Use a long tool to clear leaves or "
        "debris before placing hands inside.",
        "Large below-grade irrigation vaults may qualify as confined spaces under WorkSafeBC. A confined "
        "space hazard assessment is required before any worker enters.",
    ]))

    h.append("<h2>11. Landscape Construction Equipment Safety</h2>")
    h.append("<p>Construction equipment used in hardscape installation, grading, and demolition introduces "
             "hazards beyond ordinary maintenance work &mdash; including crush and pinch points, tip-overs, "
             "silica dust, and severe vibration exposure. The following procedures apply to all powered "
             "construction equipment.</p>")
    h.append("<h3>Operator Training and Daily Inspection</h3>")
    h.append(_ul([
        "No worker may operate a piece of equipment they have not been trained on. Training records must be "
        "on file before first use.",
        "The manufacturer's operator manual must be available at the job site or in the equipment cab.",
        "A daily pre-start inspection (fluids, oil, coolant, electrics, tracks/tires, controls, guards) must "
        "be completed and any defect reported before the machine is used.",
        "No machine may be operated with a non-functional safety device (ROPS, seatbelt, kill switch, guards, "
        "alarms). Take the machine out of service until repaired.",
        "Lockout/tagout procedures apply to any maintenance, blade or bit change, attachment swap, or "
        "unjamming task.",
    ]))
    h.append("<h3>Skid Steers, Compact Loaders, and Mini Excavators</h3>")
    h.append(_ul([
        "Seatbelt and any restraint bar must be engaged whenever the machine is moving or the boom is in motion.",
        "Only one person in the cab. Never use the bucket or attachment to lift or transport workers.",
        "Keep all body parts inside the cab while operating. Never reach through or around the lift arms.",
        "A spotter is required whenever workers, vehicles, or pedestrians are within the swing or travel zone "
        "of the machine.",
        "Do not operate on slopes that exceed the manufacturer's stated limit. Travel up and down slopes, "
        "not across, where practical.",
        "Lower attachments to the ground and engage the parking brake before exiting the cab.",
    ]))
    h.append("<h3>Compactors, Tampers, and Hand-Arm Vibration</h3>")
    h.append(_ul([
        "Plate compactors and jumping jacks transmit high vibration through the handles. Limit continuous "
        "operation and rotate operators on extended runs to stay within WorkSafeBC hand-arm vibration "
        "exposure limits.",
        "Use anti-vibration gloves rated for the equipment.",
        "Keep feet clear of the compactor plate at all times.",
        "Refuel only with the engine off and cool. Never refuel a hot engine.",
    ]))
    h.append("<h3>Cutting Concrete, Stone, and Pavers (Silica Dust)</h3>")
    h.append("<p>Crystalline silica is a designated substance under the WorkSafeBC OHS Regulation. Inhalation "
             "can cause silicosis and lung cancer. The following controls are mandatory whenever cutting, "
             "grinding, drilling, or breaking concrete, stone, or pavers:</p>")
    h.append(_ul([
        "Wet-cutting (water suppression) is the required default control. Confirm water flow before each cut.",
        "If wet-cutting is not feasible, an Exposure Control Plan must be in place and a HEPA dust extraction "
        "shroud used on the saw or grinder.",
        "Minimum respiratory protection is an N95 disposable respirator. Use a P100 half-face respirator for "
        "extended dry cutting or enclosed-area work. Workers must be fit-tested before using a tight-fitting "
        "respirator.",
        "Position cutting operations downwind of other workers and the public where possible.",
        "Clean up slurry and dust with wet methods or a HEPA vacuum. Do not dry-sweep silica dust &mdash; "
        "this re-suspends it in the breathing zone.",
        "Wash hands and exposed skin before eating, drinking, or smoking.",
    ]))
    h.append("<h3>Spotters and Working Around Equipment</h3>")
    h.append(_ul([
        "A spotter is required any time machine motion creates a blind spot near workers, the public, or "
        "property. The spotter remains in eye contact with the operator and out of the equipment's swing or "
        "travel zone.",
        "Spotters wear high-visibility vests and use clear hand signals. The operator and spotter must agree "
        "on signals before work begins.",
        "Workers on foot stay outside the machine's swing radius and never approach a machine without first "
        "making eye contact with the operator and receiving a signal to advance.",
        "Never walk or stand under a raised attachment, bucket, or load.",
    ]))

    h.append("<h2>12. Wildfire Smoke Protocol</h2>")
    h.append("<p>The Okanagan experiences wildfire smoke annually, sometimes for extended periods. Wildfire "
             "smoke contains fine particulate matter (PM2.5), carbon monoxide, and other toxic compounds "
             "that can cause serious respiratory and cardiovascular harm. This protocol applies whenever "
             "smoke is visible, air quality is degraded, or a smoke advisory is in effect for the Kelowna area.</p>")
    h.append("<h3>Monitoring Air Quality</h3>")
    h.append("<p>Supervisors must check the BC Air Quality Health Index (AQHI) before work begins each day "
             "and throughout the day during active smoke events. The AQHI is available at "
             "env.gov.bc.ca/epd/bcairquality or via the BC Air Quality app. Use the following thresholds to "
             "guide decisions:</p>")
    h.append(_table(["AQHI Rating", "Risk Level", "Colour", "Action Required"], AQHI_ROWS))
    h.append("<h3>Respirator Requirements</h3>")
    h.append(_ul([
        "Standard dust masks and surgical masks do NOT protect against wildfire smoke. Only N95 (or better) "
        "respirators filter PM2.5 particles effectively.",
        "Dario's Landscape Services will provide N95 respirators to all field workers during smoke advisories "
        "at no cost.",
        "N95 respirators must be fitted properly &mdash; a loose-fitting respirator provides little "
        "protection. Supervisors must ensure workers are wearing them correctly (seal check before each use).",
        "Disposable N95s should be replaced when breathing becomes noticeably difficult, the respirator is "
        "damaged or wet, or at the end of the workday.",
        "Workers with beards or facial hair that breaks the seal should be assigned to lighter-duty tasks "
        "with less exertion.",
    ]))
    h.append("<h3>Vulnerable Workers</h3>")
    h.append("<p>Workers with the following conditions face significantly higher risk. They must inform their "
             "supervisor so lighter-duty tasks and more frequent paid breaks can be arranged:</p>")
    h.append(_ul([
        "Asthma, COPD, or other respiratory conditions",
        "Heart disease or history of cardiovascular events",
        "Pregnancy",
        "Diabetes",
    ]))
    h.append("<p>Supervisors must not require vulnerable workers to perform heavy or strenuous outdoor work "
             "during AQHI 7+ events. Assign them to lighter-duty tasks, reduce their workload, and increase "
             "their paid rest breaks. Disclosure is voluntary &mdash; supervisors should create an "
             "environment where workers feel safe raising concerns without risk to their job.</p>")
    h.append("<h3>Symptoms to Watch For</h3>")
    h.append("<p>Supervisors and workers must watch for the following signs of smoke-related illness. If any "
             "symptom appears, remove the worker from smoke exposure immediately:</p>")
    h.append(_ul([
        "Persistent coughing, wheezing, or shortness of breath",
        "Chest tightness or pain",
        "Eye, nose, or throat irritation that does not improve with removal from smoke",
        "Rapid or irregular heartbeat",
        "Headache, dizziness, or unusual fatigue",
    ]))
    h.append("<p><strong>Symptoms that do not resolve after moving to clean air, or any chest pain or "
             "difficulty breathing, are a medical emergency &mdash; call 911.</strong></p>")
    h.append("<h3>Operational Controls</h3>")
    h.append(_ul([
        "Schedule heavy or strenuous tasks (digging, compaction, equipment operation) for early morning when "
        "smoke is typically lowest.",
        "Use vehicle cabs with recirculating air as rest areas &mdash; keep windows up and vents set to "
        "recirculate during smoke events.",
        "Increase the frequency of paid rest breaks on smoky days &mdash; these are safety-directed breaks "
        "and are paid time on the clock. Workers should spend break time in the vehicle cab with windows up "
        "and vents on recirculate.",
        "Smoke can significantly reduce visibility on job sites. Equipment operators must reduce speed and "
        "increase following distances. Spotters must remain in continuous visual contact.",
        "After a fire-affected area receives precipitation, ash and debris create slip hazards. Treat "
        "post-fire ash cleanup as a silica and hazardous material task &mdash; wet methods and N95 "
        "respirators required.",
        "If conditions deteriorate rapidly mid-shift (wind shift, new fire activity), supervisors have "
        "authority to stop heavy work immediately without management approval. Document the decision.",
    ]))
    h.append("<h3>Communication</h3>")
    h.append(_ul([
        "Supervisors must brief crews on current AQHI and any restrictions at the start of each smoky-day shift.",
        "Post the BC AQHI link or app on crew vehicles and in the shop so workers can check it themselves.",
        "If a smoke advisory is issued mid-shift, the supervisor must communicate the change and any required "
        "action to all crews immediately.",
        "Any worker who stops work or seeks medical attention due to smoke exposure must be recorded in the "
        "incident log and reviewed at the next JHSC meeting.",
    ]))

    h.append("<h2>13. Working Safely in Commercial and Public Areas</h2>")
    h.append("<p>Much of Dario's work takes place on occupied, public-facing properties &mdash; apartment and "
             "condominium complexes, strata communities, commercial plazas, business parks, and streetscapes "
             "where residents, customers, children, pets, and vehicles share the space with the crew. These "
             "environments add hazards that do not exist on a closed job site: uncontrolled foot and vehicle "
             "traffic, bystanders within range of flying debris, and a legal duty to protect the public and "
             "their property. The following procedures apply whenever work is performed in or adjacent to "
             "occupied or public areas.</p>")
    h.append("<h3>Site Assessment and Set-Up</h3>")
    h.append(_ul([
        "Before starting, walk the site and identify pedestrian routes, building entrances and exits, fire "
        "lanes, accessible parking, blind corners, playgrounds, transit stops, and the times of day traffic "
        "is heaviest.",
        "Confirm a point of contact (property manager, strata council, or site representative) and any "
        "site-specific rules, gate codes, or restricted hours before work begins.",
        "Stage tools, materials, and the truck and trailer where they do not block entrances, exits, fire "
        "lanes, accessible parking stalls, or sidewalks.",
        "Hold a brief crew huddle to assign work-zone setup and confirm who is responsible for pedestrian "
        "protection on the site.",
    ]))
    h.append("<h3>Establishing the Work Zone</h3>")
    h.append(_ul([
        "Use cones, caution tape, A-frame signs, or barricades to separate active work and equipment from "
        "pedestrian and vehicle traffic.",
        "Maintain a clear, safe walking route for the public around the work area at all times. Never force "
        "pedestrians into a traffic lane.",
        "Keep building entrances, exits, fire lanes, and accessible routes clear and usable at all times "
        "&mdash; never block them with equipment, materials, or debris.",
        "Cordon off any open trench, excavation, or hole and never leave it unattended without barricades. "
        "Cover or plate any opening left between shifts.",
    ]))
    h.append("<h3>Protecting the Public from Equipment and Debris</h3>")
    h.append(_ul([
        "Mowers, trimmers, edgers, and blowers throw debris &mdash; stone, glass, and sticks &mdash; at high "
        "velocity. Always direct the discharge away from people, windows, doors, vehicles, and pets.",
        "Stop the equipment completely when any person enters the danger zone. As a guideline, keep "
        "bystanders at least 15 m (50 ft) clear of operating string trimmers, brush cutters, and mowers.",
        "Be especially cautious trimming around hard surfaces, rock mulch, and parked vehicles, where thrown "
        "stones are most likely.",
        "Never leave running equipment unattended, even briefly. Shut off and remove the key or start device "
        "when stepping away.",
        "Control blower output near patios, entrances, open windows, parked cars, and seating areas. Reduce "
        "throttle and redirect rather than blasting debris toward people or property.",
    ]))
    h.append("<h3>Vehicles, Trailers, and Parking Lots</h3>")
    h.append(_ul([
        "Wear a high-visibility vest (Class 2 minimum) whenever working in or crossing parking lots, "
        "driveways, or near moving vehicles.",
        "Park the truck and trailer legally and safely &mdash; never in fire lanes, accessible stalls, or "
        "blocking entrances. Use hazard flashers when stopped in a traffic area.",
        "Use a spotter when backing the truck or trailer anywhere pedestrians or vehicles are present. Never "
        "assume drivers or pedestrians see you.",
        "Load and unload equipment away from active traffic lanes wherever possible. Watch for vehicles "
        "backing out of stalls &mdash; drivers are not expecting workers on foot.",
    ]))
    h.append("<h3>Working Around Occupied Buildings</h3>")
    h.append(_ul([
        "Treat every occupied property as someone's home or workplace. Conduct yourself professionally "
        "&mdash; you represent Dario's on their doorstep.",
        "Be alert for residents, children, elderly persons, people using mobility aids, and pets entering "
        "the work area. Pause work and let them pass safely.",
        "Comply with the applicable municipal noise bylaw and any strata or property-management quiet-hour "
        "rules. Confirm permitted start times before scheduling early-morning equipment work.",
        "Do not prop open secured or locked building doors, and do not share gate codes or access "
        "information with anyone outside the crew.",
        "Control overspray, dust, and clippings near windows, balconies, building finishes, and parked vehicles.",
    ]))
    h.append("<h3>Housekeeping, Slips, and Trips</h3>")
    h.append(_ul([
        "Route and coil hoses, cords, and extension leads away from walkways. Where a line must cross a "
        "pedestrian route, cover it with a cord ramp or mat and flag it.",
        "Clean clippings, soil, gravel, and debris off sidewalks, driveways, and entrances before leaving "
        "the site &mdash; hazards left in public areas are a direct liability.",
        "Place caution signage on wet or freshly pressure-washed surfaces until they are safe to walk on.",
        "Do not leave tools, materials, or equipment unattended where the public &mdash; especially children "
        "&mdash; can reach them.",
    ]))
    h.append("<h3>Chemical and Spray Application in Public Areas</h3>")
    h.append(_ul([
        "Time pesticide, herbicide, and fertilizer applications for low-traffic periods wherever possible.",
        "Post application notice signage as required and keep the public and pets off treated areas for the "
        "full re-entry interval stated on the product label and SDS.",
        "Control drift near building entrances, open windows, balconies, play areas, and seating. Do not "
        "spray in windy conditions that carry product toward people or property. See Section 7 &mdash; WHMIS "
        "and Chemical Safety.",
    ]))
    h.append("<h3>Property Damage and Incidents</h3>")
    h.append(_ul([
        "Protect glass, vehicles, signage, and building finishes from equipment and thrown debris. "
        "Reposition or shield rather than risk a strike.",
        "Report any property damage, public complaint, or near-miss involving a member of the public to your "
        "supervisor immediately, and document it. Do not admit fault or negotiate on site &mdash; report it "
        "and let management respond.",
    ]))

    h.append("<h2>14. Non-Compliance and Enforcement</h2>")
    h.append("<p>Consistent use of PPE is a condition of employment. Non-compliance will be addressed as "
             "follows:</p>")
    h.append(_table(["Occurrence", "Action", "Documentation"], NONCOMPLIANCE_ROWS))
    h.append("<p>Workers who raise concerns about PPE fit, availability, or comfort will not be penalized. "
             "The goal is compliance through support, not punishment.</p>")

    h.append("<h2>15. Worker Acknowledgement</h2>")
    h.append("<p>All workers must sign this acknowledgement upon hire and whenever this policy is updated. "
             "Signed copies are to be retained in the employee's personnel file. (The Worker Safety Sign-Off "
             "&amp; PPE Acknowledgement Form is the companion record in the Safety Program.)</p>")

    h.append("<h2>16. Version Control</h2>")
    h.append(_table(["Version", "Date", "Author", "Summary of Changes"], VERSION_ROWS))

    h.append('<p class="footer-note">Dario\'s Landscape Services Ltd. &middot; Safety &amp; PPE Policy '
             'SAF-001 v2.2 &middot; Approved: Paul Winckers, GM &middot; Effective July 26, 2026. '
             'To be posted at all field offices and crew vehicles, and reviewed with all workers during '
             'orientation. Reviewed at least annually or after any significant incident.</p>')
    return "\n".join(h)


async def seed_safety_policy_if_missing(db):
    """Insert the Safety & PPE Policy (SAF-001) if its slug is not present. Never updates."""
    rows = await db._q("SELECT 1 FROM safety_documents WHERE slug = ?", [SLUG])
    if rows:
        return 0
    body = _build_html()
    await db._x(
        """INSERT INTO safety_documents
           (slug, title, category, layer, code, summary, html, plain_text, version,
            status, field_visible, sort_order, updated_by)
           VALUES (?, ?, 'policy', 1, 'SAF-001', ?, ?, ?, '2.2', 'published', 1, 1, 'seed')""",
        [SLUG, "Safety & PPE Policy (SAF-001)",
         "Company PPE standards by task, plus heat, tick, wildfire-smoke, irrigation, "
         "construction-equipment and public-area safety protocols.",
         body, _plain(body)])
    logger.info("Seeded Safety & PPE Policy SAF-001 into the Safety Program library")
    return 1
