/**
 * ProjectHazardAssessment — the PHA form (Phase 1 of the construction safety program).
 *
 * Reusable: mounted in the field project "Safety" tab (public) and in the office
 * PHA admin page. Handles its own load / draft-save / submit / photo upload.
 *
 * Props:
 *   - oppId:   opportunity to attach a new PHA to (field tab)
 *   - phaId:   open an existing PHA by id (admin)
 *   - prefill: project info to seed a brand-new PHA from the project data
 *   - onSaved: called after a successful save/submit (so a parent list can refresh)
 */
import { useEffect, useRef, useState } from 'react';
import {
  createPHA, updatePHA, submitPHA, getPHA, listPHA,
  uploadPHAPhoto, deletePHAPhoto,
  type PHARecord, type PHAPhoto,
} from '../lib/api';

// ── Seed templates (from Dario's PHA v3) ──────────────────────────────────────

const SCOPE_PHASES = [
  'Site demolition / clearing', 'Excavation / bulk earthworks', 'Grading & fine grading',
  'Soil amendment / import / export', 'Underground irrigation rough-in',
  'Irrigation head installation & wiring', 'Irrigation controller & start-up',
  'Retaining wall construction', 'Hardscape / paver / concrete flatwork',
  'Concrete cutting or grinding', 'Drainage / catch basin installation', 'Sodding / seeding',
  'Planting (trees, shrubs, perennials)', 'Mulching / top dressing', 'Fencing / garden structures',
  'Landscape lighting installation', 'Roadside / boulevard work', 'Work in occupied / public space',
  'Final cleanup & deficiency walkthrough',
];

const SITE_CONDITIONS = [
  'Ground conditions (soil type, stability, drainage, slope)',
  'Existing vegetation / trees to protect or remove',
  'Overhead hazards (power lines, tree limbs, structures)',
  'Underground utilities — BC 1 Call ticket planned? Private utilities (irrigation, lighting, gas, septic)?',
  'Site access for equipment (gates, soft ground, overhead clearance)',
  'Traffic / pedestrian exposure (roadside, parking lot, school, park)',
  'Proximity to neighbours, buildings, or protected areas',
  'Existing site hazards (debris, open water, unstable structures)',
  'Seasonal / weather risks expected (smoke season, frost, rain)',
  'Wildlife / pest risk (ticks, wasps, bears in the area)',
  'Water source availability (dust suppression, irrigation testing)',
  'Portable sanitation / site facilities required?',
];

const PERMITS = [
  'BC 1 Call locate — 3 business days before digging',
  'Road use / lane closure permit (municipality)',
  'Traffic Control Plan (TCP)',
  'City / District permit (retaining wall, hardscape, fencing)',
  'WHMIS / SDS binder for products on site (fuel, sealers, fertilizer)',
  'Equipment operator certification (mini excavator, scissor lift)',
  'Confined space assessment (valve vaults, manholes)',
  'Notification to adjacent property owners',
  'Strata / HOA / property manager approval',
  'WorkSafeBC Prime Contractor designation confirmed and posted at site entrance',
];

const HAZARDS: { group: string; label: string; swps: string }[] = [
  { group: 'Underground & Ground Conditions', label: 'Underground utilities — public (BC 1 Call) and private', swps: 'SWP-01, SWP-02' },
  { group: 'Underground & Ground Conditions', label: 'Soil instability, slope failure, or trench collapse (>1.2 m deep)', swps: 'SWP-01' },
  { group: 'Underground & Ground Conditions', label: 'Contaminated soil or fill material', swps: '' },
  { group: 'Underground & Ground Conditions', label: 'High water table or groundwater intrusion', swps: 'SWP-01' },
  { group: 'Underground & Ground Conditions', label: 'Expansive / clay soils affecting equipment stability', swps: 'SWP-03' },
  { group: 'Equipment & Heavy Machinery', label: 'Mini excavator, skid steer, or plate compactor in use', swps: 'SWP-03, SWP-04' },
  { group: 'Equipment & Heavy Machinery', label: 'Operator qualifications — certifications verified before mobilization?', swps: 'SWP-03' },
  { group: 'Equipment & Heavy Machinery', label: 'Equipment access route — soft ground, width clearance, overhead', swps: 'SWP-03' },
  { group: 'Equipment & Heavy Machinery', label: 'Fuel and fluid storage on site', swps: '' },
  { group: 'Equipment & Heavy Machinery', label: 'Tool and equipment theft / site security', swps: '' },
  { group: 'Traffic, Pedestrian & Public Safety', label: 'Roadside or boulevard work — TCP required?', swps: 'SWP-13' },
  { group: 'Traffic, Pedestrian & Public Safety', label: 'Shared access with occupied building, school, or park', swps: 'SWP-13' },
  { group: 'Traffic, Pedestrian & Public Safety', label: 'Backing and maneuvering in confined spaces', swps: 'SWP-03, SWP-13' },
  { group: 'Traffic, Pedestrian & Public Safety', label: 'Debris / throw hazard from mowers, cutters, compactors', swps: 'SWP-10, SWP-11' },
  { group: 'Traffic, Pedestrian & Public Safety', label: 'Noise bylaw hours / neighbour disruption plan', swps: '' },
  { group: 'Dust & Air Quality', label: 'Silica dust — concrete or paver cutting throughout project', swps: 'SWP-06' },
  { group: 'Dust & Air Quality', label: 'Wildfire smoke exposure (seasonal) — N95s on hand', swps: 'SWP-14' },
  { group: 'Dust & Air Quality', label: 'Concrete / mortar mixing — alkaline burn risk', swps: 'SWP-06' },
  { group: 'Dust & Air Quality', label: 'Dust suppression on dry sites', swps: '' },
  { group: 'Environmental & Seasonal Conditions', label: 'Heat stress — extended outdoor work during summer months', swps: 'SWP-15' },
  { group: 'Environmental & Seasonal Conditions', label: 'Cold stress / frost — early season or late-season work', swps: '' },
  { group: 'Environmental & Seasonal Conditions', label: 'Ticks — brushy or wooded areas involved in scope', swps: '' },
  { group: 'Environmental & Seasonal Conditions', label: 'Wildfire evacuation — site near interface zone?', swps: 'SWP-14' },
  { group: 'Environmental & Seasonal Conditions', label: 'Erosion and sediment control during construction', swps: '' },
  { group: 'Electrical', label: 'Overhead power lines — site proximity / equipment height', swps: 'SWP-03' },
  { group: 'Electrical', label: 'Landscape lighting or irrigation wiring — low-voltage and 120V', swps: 'SWP-07, SWP-08' },
  { group: 'Electrical', label: 'Temporary power on site (generator, extension cords, GFCI)', swps: '' },
  { group: 'Electrical', label: 'Electrical disconnects / lockout required for any phase', swps: 'SWP-07' },
  { group: 'Ergonomics & Manual Handling', label: 'Repetitive heavy lifting (pavers, boulders, sod rolls, trees)', swps: 'SWP-09' },
  { group: 'Ergonomics & Manual Handling', label: 'Prolonged awkward postures (trench work, sod laying)', swps: 'SWP-09' },
  { group: 'Ergonomics & Manual Handling', label: 'Vibration exposure — compaction and power tools', swps: 'SWP-04, SWP-11' },
  { group: 'Ergonomics & Manual Handling', label: 'Crew size adequate for manual handling tasks planned?', swps: 'SWP-09' },
  { group: 'Cutting, Trimming & Chainsaw Operations', label: 'String trimmer / brushcutter — thrown debris, vibration', swps: 'SWP-11' },
  { group: 'Cutting, Trimming & Chainsaw Operations', label: 'Chainsaw — kickback, laceration, falling limbs', swps: 'SWP-12' },
  { group: 'Cutting, Trimming & Chainsaw Operations', label: 'Retaining wall / paver cutting — silica, blade contact', swps: 'SWP-05, SWP-06' },
  { group: 'Cutting, Trimming & Chainsaw Operations', label: 'Mowing — commercial rider and walk-behind', swps: 'SWP-10' },
  { group: 'Subcontractors, Prime Contractor & Coordination', label: "Prime Contractor obligations — Dario's responsible for worksite OH&S program", swps: '' },
  { group: 'Subcontractors, Prime Contractor & Coordination', label: 'Other employers on site — safety plan received and reviewed before mobilization?', swps: '' },
  { group: 'Subcontractors, Prime Contractor & Coordination', label: 'Daily FHSP/FLHA coordination between crews and subs', swps: '' },
  { group: 'Subcontractors, Prime Contractor & Coordination', label: 'Client / public on site during construction phases', swps: 'SWP-13' },
];

const PPE = [
  'CSA steel/composite-toe boots (all crew)', 'N95 respirators — smoke season and silica work',
  'First aid kit (Level 1 minimum, on site)', 'Safety glasses and/or face shields',
  'Anti-vibration gloves — compaction phases', 'Fire extinguisher (if fuel storage or cutting)',
  'Hearing protection', 'Sunscreen and wide-brim sun hats',
  'Traffic control equipment (cones, signs, vests)', 'Work gloves (cut-resistant and general)',
  'Tick repellent (DEET 20–30%)', 'GFCI outlets for all outdoor power tools',
  'Hi-visibility vests (Class 2) — roadside', 'WHMIS / SDS binder for products on site',
  'Spill kit (if fuel stored on site)', 'Hard hats — overhead hazard phases',
];

const EMERGENCY_SCENARIOS = [
  'Serious injury on site', 'Utility strike (gas, hydro, telecom)',
  'Equipment rollover or entrapment', 'Wildfire / smoke evacuation', 'Hazardous spill (fuel, chemical)',
];

const SIGNOFF_ROLES = ['Project Manager', 'Crew Lead', 'Worker Representative', 'Owner / Operations Manager'];

// ── Payload shape ─────────────────────────────────────────────────────────────

type Risk = '' | 'H' | 'M' | 'L';
interface Payload {
  project_info: Record<string, string>;
  scope_phases: { label: string; included: boolean; notes: string; custom?: boolean }[];
  site_conditions: { label: string; assessment: string; action: string; custom?: boolean }[];
  permits: { label: string; required: '' | 'yes' | 'na'; status: string; responsible: string; custom?: boolean }[];
  hazards: { group: string; label: string; swps: string; present: boolean; risk_before: Risk; controls: string; risk_after: Risk; custom?: boolean }[];
  ppe: { label: string; checked: boolean; custom?: boolean }[];
  emergency: {
    muster_point: string; cross_street: string; nearest_hospital: string; nearest_urgent_care: string;
    pm_cell: string; first_aid_attendant: string; first_aid_level: string; kit_location: string;
    scenarios: { label: string; plan: string }[];
  };
  action_items: { action: string; assigned_to: string; due_date: string; done: boolean }[];
  signoffs: { role: string; name: string; date: string }[];
  day1: { date: string; briefed_by: string; num_workers: string };
  notes: string;
}

interface Prefill {
  project_name?: string; site_address?: string; job_number?: string; client_name?: string;
  project_manager?: string; crew_lead?: string; planned_start?: string; estimated_end?: string;
}

function initialPayload(prefill?: Prefill): Payload {
  return {
    project_info: {
      project_name: prefill?.project_name || '', job_number: prefill?.job_number || '',
      assessment_date: new Date().toISOString().slice(0, 10),
      site_address: prefill?.site_address || '', municipality: '', zoning: '',
      client_name: prefill?.client_name || '', client_contact: '', onsite_client_rep: '',
      project_manager: prefill?.project_manager || '', crew_lead: prefill?.crew_lead || '',
      crew_size: '', planned_start: prefill?.planned_start || '', estimated_end: prefill?.estimated_end || '',
      est_duration: '', general_contractor: '', darios_role: '', trade_under: '',
    },
    scope_phases: SCOPE_PHASES.map(label => ({ label, included: false, notes: '' })),
    site_conditions: SITE_CONDITIONS.map(label => ({ label, assessment: '', action: '' })),
    permits: PERMITS.map(label => ({ label, required: '' as const, status: '', responsible: '' })),
    hazards: HAZARDS.map(h => ({ ...h, present: false, risk_before: '' as Risk, controls: '', risk_after: '' as Risk })),
    ppe: PPE.map(label => ({ label, checked: false })),
    emergency: {
      muster_point: '', cross_street: '',
      nearest_hospital: 'Kelowna General Hospital — 2268 Pandosy St — (250) 862-4000',
      nearest_urgent_care: '', pm_cell: '', first_aid_attendant: '', first_aid_level: '', kit_location: '',
      scenarios: EMERGENCY_SCENARIOS.map(label => ({ label, plan: '' })),
    },
    action_items: [],
    signoffs: SIGNOFF_ROLES.map(role => ({ role, name: '', date: '' })),
    day1: { date: '', briefed_by: '', num_workers: '' },
    notes: '',
  };
}

/** Merge a loaded payload over the current seed so new template rows appear and
 *  saved values are preserved (matched by label). */
function mergePayload(loaded: Partial<Payload> | undefined, prefill?: Prefill): Payload {
  const base = initialPayload(prefill);
  if (!loaded || typeof loaded !== 'object') return base;
  const byLabel = <T extends { label: string }>(seed: T[], saved: T[] | undefined): T[] => {
    if (!Array.isArray(saved)) return seed;
    const savedMap = new Map(saved.map(s => [s.label, s]));
    const merged = seed.map(s => ({ ...s, ...(savedMap.get(s.label) || {}) }));
    // keep any custom rows the user added that aren't in the seed
    const seedLabels = new Set(seed.map(s => s.label));
    for (const s of saved) if (!seedLabels.has(s.label)) merged.push(s);
    return merged;
  };
  return {
    project_info: { ...base.project_info, ...(loaded.project_info || {}) },
    scope_phases: byLabel(base.scope_phases, loaded.scope_phases as any),
    site_conditions: byLabel(base.site_conditions, loaded.site_conditions as any),
    permits: byLabel(base.permits, loaded.permits as any),
    hazards: byLabel(base.hazards, loaded.hazards as any),
    ppe: byLabel(base.ppe, loaded.ppe as any),
    emergency: { ...base.emergency, ...(loaded.emergency || {}),
      scenarios: Array.isArray(loaded.emergency?.scenarios) && loaded.emergency!.scenarios.length
        ? loaded.emergency!.scenarios : base.emergency.scenarios },
    action_items: Array.isArray(loaded.action_items) ? loaded.action_items : base.action_items,
    signoffs: Array.isArray(loaded.signoffs) && loaded.signoffs.length ? loaded.signoffs : base.signoffs,
    day1: { ...base.day1, ...(loaded.day1 || {}) },
    notes: loaded.notes || '',
  };
}

// ── Styles ────────────────────────────────────────────────────────────────────

const C = {
  navy: '#1A5376', input: { width: '100%', boxSizing: 'border-box' as const, padding: '9px 11px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, color: '#111827', fontFamily: 'inherit' },
  ta: { width: '100%', boxSizing: 'border-box' as const, padding: '9px 11px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, color: '#111827', fontFamily: 'inherit', minHeight: 44, resize: 'vertical' as const },
  lbl: { display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.04em', marginBottom: 4 },
};

function Section({ n, title, subtitle, children, defaultOpen }: { n: number; title: string; subtitle?: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, marginBottom: 14, overflow: 'hidden', background: '#fff' }}>
      <div onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: C.navy, color: '#fff', cursor: 'pointer' }}>
        <span style={{ background: 'rgba(255,255,255,0.2)', width: 24, height: 24, borderRadius: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, flexShrink: 0 }}>{n}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
          {subtitle && <div style={{ fontSize: 11, opacity: 0.85, marginTop: 1 }}>{subtitle}</div>}
        </div>
        <span style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s', fontSize: 13 }}>▼</span>
      </div>
      {open && <div style={{ padding: 16 }}>{children}</div>}
    </div>
  );
}

function RiskPicker({ value, onChange }: { value: Risk; onChange: (r: Risk) => void }) {
  const opts: { v: Risk; c: string }[] = [{ v: 'H', c: '#dc2626' }, { v: 'M', c: '#d97706' }, { v: 'L', c: '#16a34a' }];
  return (
    <div style={{ display: 'inline-flex', gap: 4 }}>
      {opts.map(o => (
        <button key={o.v} type="button" onClick={() => onChange(value === o.v ? '' : o.v)}
          style={{ width: 30, height: 30, borderRadius: 7, border: `1.5px solid ${value === o.v ? o.c : '#d1d5db'}`, background: value === o.v ? o.c : '#fff', color: value === o.v ? '#fff' : '#9ca3af', fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>
          {o.v}
        </button>
      ))}
    </div>
  );
}

// ── Component ───────────────────────────────────────────────────────────────────

export default function ProjectHazardAssessment({
  oppId, phaId: initialPhaId, prefill, onSaved,
}: {
  oppId?: number | null;
  phaId?: number;
  prefill?: Prefill;
  onSaved?: () => void;
}) {
  const [p, setP] = useState<Payload>(() => initialPayload(prefill));
  const [phaId, setPhaId] = useState<number | null>(initialPhaId ?? null);
  const [phaNumber, setPhaNumber] = useState<string | null>(null);
  const [status, setStatus] = useState<'draft' | 'submitted'>('draft');
  const [photos, setPhotos] = useState<PHAPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Load existing (by phaId, else newest for oppId); otherwise start fresh.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        let rec: PHARecord | null = null;
        if (initialPhaId) {
          rec = await getPHA(initialPhaId);
        } else if (oppId != null) {
          const list = await listPHA({ opportunity_id: oppId });
          if (list.length) rec = await getPHA(list[0].id);
        }
        if (cancelled) return;
        if (rec) {
          setPhaId(rec.id); setPhaNumber(rec.pha_number); setStatus(rec.status);
          setP(mergePayload(rec.payload as Partial<Payload>, prefill));
          setPhotos(rec.photos || []);
        }
      } catch (e) {
        if (!cancelled) setMsg(`Could not load: ${(e as Error).message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPhaId, oppId]);

  function up(patch: Partial<Payload>) { setP(prev => ({ ...prev, ...patch })); }
  function upInfo(k: string, v: string) { setP(prev => ({ ...prev, project_info: { ...prev.project_info, [k]: v } })); }

  async function ensureId(): Promise<number> {
    if (phaId) return phaId;
    const rec = await createPHA({
      opportunity_id: oppId ?? null,
      project_name: p.project_info.project_name,
      site_address: p.project_info.site_address,
      created_by: p.project_info.project_manager || p.project_info.crew_lead || undefined,
      payload: p as unknown as Record<string, unknown>,
    });
    setPhaId(rec.id); setPhaNumber(rec.pha_number); setStatus(rec.status);
    return rec.id;
  }

  async function saveDraft(silent = false): Promise<number | null> {
    setSaving(true); if (!silent) setMsg('');
    try {
      let id = phaId;
      if (!id) { id = await ensureId(); }
      else {
        const rec = await updatePHA(id, {
          opportunity_id: oppId ?? null,
          project_name: p.project_info.project_name,
          site_address: p.project_info.site_address,
          payload: p as unknown as Record<string, unknown>,
        });
        setPhaNumber(rec.pha_number); setStatus(rec.status);
      }
      if (!silent) { setMsg('✅ Draft saved'); setTimeout(() => setMsg(''), 2500); }
      onSaved?.();
      return id;
    } catch (e) {
      setMsg(`❌ ${(e as Error).message}`);
      return null;
    } finally { setSaving(false); }
  }

  async function submit() {
    if (!p.project_info.project_name.trim()) { setMsg('❌ Enter a project name before submitting'); return; }
    if (!p.signoffs.some(s => s.name.trim())) { setMsg('❌ At least one sign-off is required to submit'); return; }
    setSaving(true); setMsg('');
    try {
      const id = await saveDraft(true);
      if (!id) return;
      const by = p.signoffs.find(s => s.name.trim())?.name || p.project_info.project_manager || '';
      const rec = await submitPHA(id, by);
      setStatus(rec.status);
      setMsg('✅ PHA submitted and sent to the safety team');
      onSaved?.();
    } catch (e) {
      setMsg(`❌ ${(e as Error).message}`);
    } finally { setSaving(false); }
  }

  async function onAddPhotos(files: FileList | null) {
    if (!files || !files.length) return;
    setUploading(true); setMsg('');
    try {
      const id = await ensureId();
      for (const f of Array.from(files)) {
        try {
          const ph = await uploadPHAPhoto(id, f);
          setPhotos(prev => [...prev, ph]);
        } catch (e) {
          setMsg(`❌ ${f.name}: ${(e as Error).message}`);
        }
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function removePhoto(key: string) {
    if (!phaId) return;
    await deletePHAPhoto(phaId, key).catch(() => {});
    setPhotos(prev => prev.filter(ph => ph.key !== key));
  }

  if (loading) return <div style={{ padding: 30, textAlign: 'center', color: '#9ca3af' }}>Loading assessment…</div>;

  const locked = status === 'submitted';
  const info = p.project_info;

  // group hazards for display
  const hazGroups = Array.from(new Set(p.hazards.map(h => h.group)));

  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', position: 'relative', paddingBottom: 80 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: '#111827' }}>🦺 Project Hazard Assessment</div>
        {phaNumber && <span style={{ fontSize: 12, fontWeight: 700, color: '#6b7280' }}>{phaNumber}</span>}
        <span style={{ background: locked ? '#dcfce7' : '#fef3c7', color: locked ? '#15803d' : '#92400e', padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 800 }}>
          {locked ? 'SUBMITTED' : 'DRAFT'}
        </span>
      </div>
      <p style={{ margin: '0 0 16px', color: '#6b7280', fontSize: 13 }}>
        Complete BEFORE mobilization. Review with the full crew on Day 1. Save a draft any time and finish later.
      </p>

      {/* 1. Project Information */}
      <Section n={1} title="Project Information" defaultOpen>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {([
            ['project_name', 'Project Name / Description'], ['job_number', 'Work Order / Job #'],
            ['assessment_date', 'Date of This Assessment'], ['site_address', 'Site Address / Legal Description'],
            ['municipality', 'Municipality / Jurisdiction'], ['zoning', 'Zoning / Property Type'],
            ['client_name', 'Client Name'], ['client_contact', 'Client Contact & Phone'],
            ['onsite_client_rep', 'On-Site Client Representative'], ['project_manager', 'Project Manager'],
            ['crew_lead', 'Crew Lead'], ['crew_size', 'Estimated Crew Size'],
            ['planned_start', 'Planned Start Date'], ['estimated_end', 'Estimated End Date'],
            ['est_duration', 'Est. Project Duration'], ['general_contractor', 'General Contractor / Owner (if any)'],
          ] as [string, string][]).map(([k, lbl]) => (
            <div key={k}>
              <label style={C.lbl}>{lbl}</label>
              <input style={C.input} disabled={locked} value={info[k] || ''}
                type={k === 'assessment_date' || k === 'planned_start' || k === 'estimated_end' ? 'date' : 'text'}
                onChange={e => upInfo(k, e.target.value)} />
            </div>
          ))}
        </div>
        <div style={{ marginTop: 14 }}>
          <label style={C.lbl}>Dario's Role on This Project</label>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {['Prime Contractor', 'Trade Contractor'].map(r => (
              <button key={r} type="button" disabled={locked} onClick={() => upInfo('darios_role', r)}
                style={{ padding: '8px 14px', borderRadius: 8, border: `1.5px solid ${info.darios_role === r ? C.navy : '#d1d5db'}`, background: info.darios_role === r ? C.navy : '#fff', color: info.darios_role === r ? '#fff' : '#374151', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                {r}
              </button>
            ))}
            {info.darios_role === 'Trade Contractor' && (
              <input style={{ ...C.input, flex: 1, minWidth: 180 }} disabled={locked} placeholder="Under (GC name)…" value={info.trade_under || ''} onChange={e => upInfo('trade_under', e.target.value)} />
            )}
          </div>
          {info.darios_role === 'Prime Contractor' && (
            <div style={{ marginTop: 10, background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: '#7c2d12', lineHeight: 1.5 }}>
              <b>Prime Contractor:</b> Post "Prime Contractor: Dario's Landscape Services Ltd." at the site entrance before Day 1. Dario's supervisor holds full worksite safety authority (WorkSafeBC OHS Reg. ss. 118–119). Ensure other employers on site have their own OH&S programs and are briefed on this PHA.
            </div>
          )}
        </div>
      </Section>

      {/* 2. Scope & Phases */}
      <Section n={2} title="Project Scope & Phases" subtitle="Check all work types in this project; add timing notes.">
        {p.scope_phases.map((ph, i) => (
          <div key={ph.label + i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '7px 0', borderBottom: '1px solid #f3f4f6' }}>
            <input type="checkbox" disabled={locked} checked={ph.included} style={{ marginTop: 10, width: 18, height: 18, flexShrink: 0 }}
              onChange={e => up({ scope_phases: p.scope_phases.map((x, j) => j === i ? { ...x, included: e.target.checked } : x) })} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, color: '#111827', fontWeight: ph.included ? 700 : 400 }}>{ph.label}</div>
              {ph.included && (
                <input style={{ ...C.input, marginTop: 5, fontSize: 13 }} disabled={locked} placeholder="Estimated timing / notes" value={ph.notes}
                  onChange={e => up({ scope_phases: p.scope_phases.map((x, j) => j === i ? { ...x, notes: e.target.value } : x) })} />
              )}
            </div>
            {ph.custom && !locked && (
              <button type="button" onClick={() => up({ scope_phases: p.scope_phases.filter((_, j) => j !== i) })} style={delBtn}>✕</button>
            )}
          </div>
        ))}
        {!locked && <AddRow placeholder="Add another work type…" onAdd={v => up({ scope_phases: [...p.scope_phases, { label: v, included: true, notes: '', custom: true }] })} />}
      </Section>

      {/* 3. Site Conditions */}
      <Section n={3} title="Site Conditions Assessment" subtitle="Complete during the pre-start site visit.">
        {p.site_conditions.map((c, i) => (
          <div key={c.label + i} style={{ padding: '10px 0', borderBottom: '1px solid #f3f4f6' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 6 }}>
              {c.label}
              {c.custom && !locked && <button type="button" onClick={() => up({ site_conditions: p.site_conditions.filter((_, j) => j !== i) })} style={{ ...delBtn, float: 'right' }}>✕</button>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <textarea style={C.ta} disabled={locked} placeholder="Assessment / notes" value={c.assessment}
                onChange={e => up({ site_conditions: p.site_conditions.map((x, j) => j === i ? { ...x, assessment: e.target.value } : x) })} />
              <textarea style={C.ta} disabled={locked} placeholder="Action required before mobilization" value={c.action}
                onChange={e => up({ site_conditions: p.site_conditions.map((x, j) => j === i ? { ...x, action: e.target.value } : x) })} />
            </div>
          </div>
        ))}
        {!locked && <AddRow placeholder="Add another site condition…" onAdd={v => up({ site_conditions: [...p.site_conditions, { label: v, assessment: '', action: '', custom: true }] })} />}
      </Section>

      {/* 4. Permits & Regulatory */}
      <Section n={4} title="Permits, Certifications & Regulatory">
        {p.permits.map((pm, i) => (
          <div key={pm.label + i} style={{ padding: '10px 0', borderBottom: '1px solid #f3f4f6' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 6 }}>
              {pm.label}
              {pm.custom && !locked && <button type="button" onClick={() => up({ permits: p.permits.filter((_, j) => j !== i) })} style={{ ...delBtn, float: 'right' }}>✕</button>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ display: 'inline-flex', gap: 4 }}>
                {(['yes', 'na'] as const).map(r => (
                  <button key={r} type="button" disabled={locked} onClick={() => up({ permits: p.permits.map((x, j) => j === i ? { ...x, required: x.required === r ? '' : r } : x) })}
                    style={{ padding: '6px 12px', borderRadius: 7, border: `1.5px solid ${pm.required === r ? C.navy : '#d1d5db'}`, background: pm.required === r ? C.navy : '#fff', color: pm.required === r ? '#fff' : '#6b7280', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
                    {r === 'yes' ? 'Required' : 'N/A'}
                  </button>
                ))}
              </div>
              <input style={{ ...C.input, flex: 2, minWidth: 140 }} disabled={locked} placeholder="Status / notes" value={pm.status}
                onChange={e => up({ permits: p.permits.map((x, j) => j === i ? { ...x, status: e.target.value } : x) })} />
              <input style={{ ...C.input, flex: 1, minWidth: 110 }} disabled={locked} placeholder="Responsible" value={pm.responsible}
                onChange={e => up({ permits: p.permits.map((x, j) => j === i ? { ...x, responsible: e.target.value } : x) })} />
            </div>
          </div>
        ))}
        {!locked && <AddRow placeholder="Add another requirement…" onAdd={v => up({ permits: [...p.permits, { label: v, required: '', status: '', responsible: '', custom: true }] })} />}
      </Section>

      {/* 5. Hazard Assessment */}
      <Section n={5} title="Project-Level Hazard Assessment" subtitle="Check hazards present, rate risk before/after controls.">
        {hazGroups.map(group => (
          <div key={group} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: C.navy, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '8px 0 4px', borderBottom: `2px solid ${C.navy}22` }}>{group}</div>
            {p.hazards.map((h, i) => h.group !== group ? null : (
              <div key={h.label + i} style={{ padding: '9px 0', borderBottom: '1px solid #f3f4f6' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input type="checkbox" disabled={locked} checked={h.present} style={{ marginTop: 3, width: 18, height: 18, flexShrink: 0 }}
                    onChange={e => up({ hazards: p.hazards.map((x, j) => j === i ? { ...x, present: e.target.checked } : x) })} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, color: '#111827', fontWeight: h.present ? 700 : 400 }}>
                      {h.label}
                      {h.swps && <span style={{ fontSize: 10.5, color: '#7c3aed', fontWeight: 700, marginLeft: 6 }}>{h.swps}</span>}
                      {h.custom && !locked && <button type="button" onClick={() => up({ hazards: p.hazards.filter((_, j) => j !== i) })} style={{ ...delBtn, float: 'right' }}>✕</button>}
                    </div>
                    {h.present && (
                      <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 7 }}>
                        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                          <span style={{ fontSize: 11, color: '#6b7280' }}>Risk before <RiskPicker value={h.risk_before} onChange={r => up({ hazards: p.hazards.map((x, j) => j === i ? { ...x, risk_before: r } : x) })} /></span>
                          <span style={{ fontSize: 11, color: '#6b7280' }}>Risk after <RiskPicker value={h.risk_after} onChange={r => up({ hazards: p.hazards.map((x, j) => j === i ? { ...x, risk_after: r } : x) })} /></span>
                        </div>
                        <textarea style={C.ta} disabled={locked} placeholder="Controls / mitigation plan" value={h.controls}
                          onChange={e => up({ hazards: p.hazards.map((x, j) => j === i ? { ...x, controls: e.target.value } : x) })} />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
        {!locked && <AddRow placeholder="Add a site-specific hazard…" onAdd={v => up({ hazards: [...p.hazards, { group: 'Site-Specific', label: v, swps: '', present: true, risk_before: '', controls: '', risk_after: '', custom: true }] })} />}
      </Section>

      {/* 6. PPE */}
      <Section n={6} title="PPE & Safety Equipment" subtitle="Check all required on site before Day 1.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 4 }}>
          {p.ppe.map((item, i) => (
            <label key={item.label + i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 4px', fontSize: 13.5, color: '#111827', cursor: locked ? 'default' : 'pointer' }}>
              <input type="checkbox" disabled={locked} checked={item.checked} style={{ width: 18, height: 18, flexShrink: 0 }}
                onChange={e => up({ ppe: p.ppe.map((x, j) => j === i ? { ...x, checked: e.target.checked } : x) })} />
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.custom && !locked && <button type="button" onClick={() => up({ ppe: p.ppe.filter((_, j) => j !== i) })} style={delBtn}>✕</button>}
            </label>
          ))}
        </div>
        {!locked && <AddRow placeholder="Add PPE / equipment…" onAdd={v => up({ ppe: [...p.ppe, { label: v, checked: true, custom: true }] })} />}
      </Section>

      {/* 7. Emergency Preparedness */}
      <Section n={7} title="Emergency Preparedness">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {([
            ['muster_point', 'Emergency Muster Point on Site'], ['cross_street', 'Nearest Cross Street / Intersection'],
            ['nearest_hospital', 'Nearest Hospital'], ['nearest_urgent_care', 'Nearest Urgent Care'],
            ['pm_cell', 'Project Manager Cell'], ['first_aid_attendant', 'First Aid Attendant on Site'],
            ['first_aid_level', 'First Aid Cert Level'], ['kit_location', 'Kit Location'],
          ] as [string, string][]).map(([k, lbl]) => (
            <div key={k}>
              <label style={C.lbl}>{lbl}</label>
              <input style={C.input} disabled={locked} value={(p.emergency as any)[k] || ''}
                onChange={e => up({ emergency: { ...p.emergency, [k]: e.target.value } })} />
            </div>
          ))}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>WorkSafeBC emergency line: <b>1-888-621-7233</b></div>
        <div style={{ marginTop: 14 }}>
          <label style={C.lbl}>Emergency Response Plans</label>
          {p.emergency.scenarios.map((sc, i) => (
            <div key={sc.label + i} style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8, marginBottom: 6, alignItems: 'start' }}>
              <div style={{ fontSize: 13, color: '#111827', fontWeight: 600, paddingTop: 9 }}>{sc.label}</div>
              <textarea style={C.ta} disabled={locked} placeholder="Response plan" value={sc.plan}
                onChange={e => up({ emergency: { ...p.emergency, scenarios: p.emergency.scenarios.map((x, j) => j === i ? { ...x, plan: e.target.value } : x) } })} />
            </div>
          ))}
        </div>
      </Section>

      {/* 8. Action Items */}
      <Section n={8} title="Action Items" subtitle="Must be resolved before mobilization.">
        {p.action_items.map((a, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 7, flexWrap: 'wrap' }}>
            <input type="checkbox" disabled={locked} checked={a.done} style={{ width: 18, height: 18 }}
              onChange={e => up({ action_items: p.action_items.map((x, j) => j === i ? { ...x, done: e.target.checked } : x) })} />
            <input style={{ ...C.input, flex: 3, minWidth: 160, textDecoration: a.done ? 'line-through' : 'none' }} disabled={locked} placeholder="Action required" value={a.action}
              onChange={e => up({ action_items: p.action_items.map((x, j) => j === i ? { ...x, action: e.target.value } : x) })} />
            <input style={{ ...C.input, flex: 1, minWidth: 110 }} disabled={locked} placeholder="Assigned to" value={a.assigned_to}
              onChange={e => up({ action_items: p.action_items.map((x, j) => j === i ? { ...x, assigned_to: e.target.value } : x) })} />
            <input style={{ ...C.input, width: 150 }} type="date" disabled={locked} value={a.due_date}
              onChange={e => up({ action_items: p.action_items.map((x, j) => j === i ? { ...x, due_date: e.target.value } : x) })} />
            {!locked && <button type="button" onClick={() => up({ action_items: p.action_items.filter((_, j) => j !== i) })} style={delBtn}>✕</button>}
          </div>
        ))}
        {!locked && (
          <button type="button" onClick={() => up({ action_items: [...p.action_items, { action: '', assigned_to: '', due_date: '', done: false }] })}
            style={{ marginTop: 6, padding: '8px 14px', borderRadius: 8, border: '1px dashed #9ca3af', background: '#f9fafb', color: '#374151', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            + Add action item
          </button>
        )}
      </Section>

      {/* 9. Sign-Off */}
      <Section n={9} title="Sign-Off" subtitle="Each party confirms they reviewed the hazards and controls.">
        {p.signoffs.map((s, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <input style={{ ...C.input, flex: 1, minWidth: 140 }} disabled={locked} placeholder="Role" value={s.role}
              onChange={e => up({ signoffs: p.signoffs.map((x, j) => j === i ? { ...x, role: e.target.value } : x) })} />
            <input style={{ ...C.input, flex: 2, minWidth: 160 }} disabled={locked} placeholder="Name (print)" value={s.name}
              onChange={e => up({ signoffs: p.signoffs.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} />
            <input style={{ ...C.input, width: 150 }} type="date" disabled={locked} value={s.date}
              onChange={e => up({ signoffs: p.signoffs.map((x, j) => j === i ? { ...x, date: e.target.value } : x) })} />
            {!locked && i >= SIGNOFF_ROLES.length && <button type="button" onClick={() => up({ signoffs: p.signoffs.filter((_, j) => j !== i) })} style={delBtn}>✕</button>}
          </div>
        ))}
        {!locked && (
          <button type="button" onClick={() => up({ signoffs: [...p.signoffs, { role: '', name: '', date: '' }] })}
            style={{ margin: '4px 0 14px', padding: '8px 14px', borderRadius: 8, border: '1px dashed #9ca3af', background: '#f9fafb', color: '#374151', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            + Add signatory
          </button>
        )}
        <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 8 }}>Day 1 Crew Briefing</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            <div><label style={C.lbl}>Date completed</label><input type="date" style={C.input} disabled={locked} value={p.day1.date} onChange={e => up({ day1: { ...p.day1, date: e.target.value } })} /></div>
            <div><label style={C.lbl}>Briefed by</label><input style={C.input} disabled={locked} value={p.day1.briefed_by} onChange={e => up({ day1: { ...p.day1, briefed_by: e.target.value } })} /></div>
            <div><label style={C.lbl}># workers briefed</label><input style={C.input} disabled={locked} value={p.day1.num_workers} onChange={e => up({ day1: { ...p.day1, num_workers: e.target.value } })} /></div>
          </div>
        </div>
      </Section>

      {/* Reference Photos */}
      <Section n={10} title="Reference Photos" subtitle="Site visit photos, utility locates, permit copies.">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {photos.map(ph => (
            <div key={ph.key} style={{ position: 'relative', width: 110, height: 110, borderRadius: 8, overflow: 'hidden', border: '1px solid #e5e7eb', background: '#f3f4f6' }}>
              {ph.url
                ? <a href={ph.url} target="_blank" rel="noopener noreferrer"><img src={ph.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></a>
                : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 26 }}>📎</div>}
              {!locked && <button type="button" onClick={() => removePhoto(ph.key)} style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none', borderRadius: '50%', width: 22, height: 22, cursor: 'pointer', fontSize: 12 }}>✕</button>}
            </div>
          ))}
          {!locked && (
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
              style={{ width: 110, height: 110, borderRadius: 8, border: '2px dashed #9ca3af', background: '#f9fafb', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              {uploading ? '⏳' : '+ Photo'}
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" multiple capture="environment" style={{ display: 'none' }} onChange={e => onAddPhotos(e.target.files)} />
        </div>
      </Section>

      {/* Sticky action bar */}
      {!locked ? (
        <div style={{ position: 'sticky', bottom: 0, background: '#fff', borderTop: '1px solid #e5e7eb', padding: '12px 0', marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => saveDraft()} disabled={saving}
            style={{ padding: '11px 20px', borderRadius: 10, border: `1.5px solid ${C.navy}`, background: '#fff', color: C.navy, fontWeight: 800, fontSize: 14, cursor: saving ? 'default' : 'pointer' }}>
            {saving ? 'Saving…' : '💾 Save draft'}
          </button>
          <button onClick={submit} disabled={saving}
            style={{ padding: '11px 22px', borderRadius: 10, border: 'none', background: saving ? '#94a3b8' : C.navy, color: '#fff', fontWeight: 800, fontSize: 14, cursor: saving ? 'default' : 'pointer' }}>
            Submit PHA →
          </button>
          {msg && <span style={{ fontSize: 13, fontWeight: 600, color: msg.startsWith('✅') ? '#15803d' : '#b91c1c' }}>{msg}</span>}
        </div>
      ) : (
        <div style={{ marginTop: 10, padding: '14px 16px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, color: '#15803d', fontSize: 14, fontWeight: 600 }}>
          ✅ This PHA was submitted{p.signoffs.find(s => s.name)?.name ? '' : ''} and is locked. {msg}
        </div>
      )}
    </div>
  );
}

const delBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#dc2626', fontSize: 14, cursor: 'pointer', fontWeight: 700, flexShrink: 0 };

function AddRow({ placeholder, onAdd }: { placeholder: string; onAdd: (v: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
      <input style={{ ...C.input, flex: 1 }} placeholder={placeholder} value={v}
        onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (v.trim()) { onAdd(v.trim()); setV(''); } } }} />
      <button type="button" onClick={() => { if (v.trim()) { onAdd(v.trim()); setV(''); } }}
        style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', color: '#374151', fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>+ Add</button>
    </div>
  );
}
