/**
 * FieldPurchaseOrder.tsx — Create a Purchase Order (Aspire Receipt) from the field.
 * Accessible at /field/purchase-order (no login required)
 *
 * Flow:
 *   1. Job search — find job/work-ticket OR choose "No job (inventory)"
 *   2. (If job found with tickets) Pick work ticket
 *   3. Vendor picker — preferred list + live search
 *   4. Line items — up to 5 rows
 *   5. Notes + your name
 *   6. Review & submit
 *   7. Success — show PO number
 */

import { useState, useEffect, useRef } from 'react';
import {
  getPOVendors,
  searchPOJobs,
  getPOWorkTickets,
  getWorkTicketMaterials,
  createPurchaseOrder,
  getAspireEmployees,
  getPOUomTypes,
  searchCatalogItems,
  type POVendor,
  type POJobResult,
  type POWorkTicket,
  type POLineItem,
  type POTicketItem,
  type AspireEmployee,
  type POUomType,
  type CatalogItem,
} from '../lib/api';

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const S: React.CSSProperties = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
};
const BG   = '#0f172a';
const CARD = '#1e293b';
const GRN  = '#22c55e';
const BLU  = '#3b82f6';


const EMPTY_ITEM: POLineItem = { description: '', qty: 1, unit_cost: 0, uom: '' };

export default function FieldPurchaseOrder() {
  const [step, setStep] = useState<Step>(1);

  // Job / ticket selection
  const [jobQuery, setJobQuery]           = useState('');
  const [jobResults, setJobResults]       = useState<POJobResult[]>([]);
  const [jobLoading, setJobLoading]       = useState(false);
  const [selectedJob, setSelectedJob]     = useState<POJobResult | null>(null);
  const [workTickets, setWorkTickets]     = useState<POWorkTicket[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<POWorkTicket | null>(null);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [inventoryOnly, setInventoryOnly] = useState(false);

  // Vendor selection
  const [vendors, setVendors]             = useState<POVendor[]>([]);
  const [vendorQuery, setVendorQuery]     = useState('');
  const [vendorLoading, setVendorLoading] = useState(false);
  const [selectedVendor, setSelectedVendor] = useState<POVendor | null>(null);

  // Line items
  const [items, setItems] = useState<POLineItem[]>([{ ...EMPTY_ITEM }]);
  const [ticketItems, setTicketItems]     = useState<POTicketItem[]>([]);
  const [ticketItemsLoading, setTicketItemsLoading] = useState(false);
  const [uomTypes, setUomTypes]           = useState<POUomType[]>([]);

  // Catalog item search (per row)
  const [catalogResults, setCatalogResults] = useState<CatalogItem[][]>(Array(5).fill([]));
  const [catalogLoading, setCatalogLoading] = useState<boolean[]>(Array(5).fill(false));
  const catalogTimers = useRef<(ReturnType<typeof setTimeout> | null)[]>(Array(5).fill(null));

  // Notes + name
  const [notes, setNotes]         = useState('');
  const [employees, setEmployees] = useState<AspireEmployee[]>([]);
  const [empName, setEmpName]     = useState('');

  // Submission
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult]         = useState<{ receipt_id: number | null; display_number: number | null; total: number } | null>(null);
  const [error, setError]           = useState('');

  const jobTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vendorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load preferred vendors, employee list, and UOM types on mount
  useEffect(() => {
    getPOVendors().then(r => setVendors(r.vendors)).catch(() => {});
    getAspireEmployees().then(r => setEmployees(r)).catch(() => {});
    getPOUomTypes().then(r => setUomTypes(r)).catch(() => {});
  }, []);

  // Debounced job search
  useEffect(() => {
    if (!jobQuery.trim()) { setJobResults([]); return; }
    if (jobTimer.current) clearTimeout(jobTimer.current);
    jobTimer.current = setTimeout(async () => {
      setJobLoading(true);
      try {
        const r = await searchPOJobs(jobQuery.trim());
        setJobResults(r.results);
      } catch { setJobResults([]); }
      finally { setJobLoading(false); }
    }, 400);
  }, [jobQuery]);

  // Debounced vendor search
  useEffect(() => {
    if (!vendorQuery.trim()) {
      getPOVendors().then(r => setVendors(r.vendors)).catch(() => {});
      return;
    }
    if (vendorTimer.current) clearTimeout(vendorTimer.current);
    vendorTimer.current = setTimeout(async () => {
      setVendorLoading(true);
      try {
        const r = await getPOVendors(vendorQuery.trim());
        setVendors(r.vendors);
      } catch { setVendors([]); }
      finally { setVendorLoading(false); }
    }, 400);
  }, [vendorQuery]);

  async function fetchTicketItems(ticketId: number) {
    setTicketItemsLoading(true);
    try {
      const r = await getWorkTicketMaterials(ticketId);
      setTicketItems(r.items);
    } catch { setTicketItems([]); }
    finally { setTicketItemsLoading(false); }
  }

  function loadTicketItemsIntoForm() {
    if (!ticketItems.length) return;
    setItems(ticketItems.map(ti => ({
      description:     ti.name,
      qty:             ti.qty,
      unit_cost:       ti.unit_cost,
      uom:             ti.uom || '',
      catalog_item_id: ti.catalog_item_id ?? null,
    })));
  }

  async function selectJob(job: POJobResult) {
    setSelectedJob(job);
    setSelectedTicket(null);
    setTicketItems([]);
    if (job.opportunity_id && job.type === 'opportunity') {
      // Load work tickets so user can optionally pin one
      setTicketsLoading(true);
      try {
        const r = await getPOWorkTickets(job.opportunity_id);
        setWorkTickets(r.tickets);
        // If only one ticket, auto-select it
        if (r.tickets.length === 1) setSelectedTicket(r.tickets[0]);
      } catch { setWorkTickets([]); }
      finally { setTicketsLoading(false); }
      setStep(2);
    } else {
      // Already have a work ticket from the search
      if (job.work_ticket_id) {
        const ticket = {
          WorkTicketID:         job.work_ticket_id,
          WorkTicketNumber:     job.work_ticket_num ?? 0,
          WorkTicketTitle:      job.work_ticket_title ?? null,
          WorkTicketStatusName: job.status,
          ScheduledStartDate:   job.date,
          PropertyName:         job.property_name,
        };
        setSelectedTicket(ticket);
        fetchTicketItems(job.work_ticket_id);
      }
      setStep(3); // skip to vendor
    }
  }

  function skipJob() {
    setInventoryOnly(true);
    setSelectedJob(null);
    setSelectedTicket(null);
    setStep(3);
  }

  function updateItem(i: number, field: keyof POLineItem, val: string | number) {
    const numericFields = new Set<keyof POLineItem>(['qty', 'unit_cost']);
    setItems(prev => prev.map((it, idx) =>
      idx === i ? { ...it, [field]: numericFields.has(field) ? Number(val) : val } : it
    ));
  }

  function addItem() {
    if (items.length < 5) setItems(prev => [...prev, { ...EMPTY_ITEM }]);
  }

  function removeItem(i: number) {
    if (items.length > 1) setItems(prev => prev.filter((_, idx) => idx !== i));
  }

  const validItems = items.filter(it => it.description.trim());

  async function submit() {
    if (!selectedVendor?.vendor_id) { setError('Please select a vendor.'); return; }
    if (!validItems.length) { setError('Please fill in at least one item with a description and cost.'); return; }
    if (!empName.trim()) { setError('Please select your name.'); return; }

    setSubmitting(true);
    setError('');
    try {
      const res = await createPurchaseOrder({
        requesterName: empName,
        vendorId:      selectedVendor.vendor_id,
        vendorName:    selectedVendor.vendor_name,
        workTicketId:  selectedTicket?.WorkTicketID ?? null,
        opportunityId: selectedJob?.opportunity_id ?? null,
        jobName:       selectedJob?.opportunity_name ?? null,
        notes,
        items: validItems,
      });
      setResult({ receipt_id: res.receipt_id, display_number: res.display_number, total: res.total });
      setStep(7);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  const wrap: React.CSSProperties = {
    minHeight: '100vh', background: BG, padding: '16px',
    ...S, color: '#fff',
  };
  const card: React.CSSProperties = {
    background: CARD, borderRadius: 12, padding: 16, marginBottom: 12,
  };
  const inp: React.CSSProperties = {
    width: '100%', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 8, color: '#fff', padding: '10px 12px', fontSize: 15,
    boxSizing: 'border-box',
  };
  const btn = (col = GRN): React.CSSProperties => ({
    width: '100%', padding: '14px', background: col, color: '#fff',
    border: 'none', borderRadius: 10, fontSize: 16, fontWeight: 700,
    cursor: 'pointer', marginTop: 8,
  });
  const ghost: React.CSSProperties = {
    ...btn(), background: 'transparent', border: `1px solid #334155`,
    color: '#94a3b8', marginTop: 4,
  };
  const row: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '12px 14px', background: '#0f172a', borderRadius: 8,
    marginBottom: 8, cursor: 'pointer', border: '1px solid #1e293b',
  };
  const label: React.CSSProperties = { color: '#94a3b8', fontSize: 12, marginBottom: 4 };

  function pill(txt: string) {
    return (
      <span style={{ background: '#1e3a5f', color: '#93c5fd', fontSize: 11,
        padding: '2px 8px', borderRadius: 20, marginLeft: 8 }}>{txt}</span>
    );
  }

  function header(title: string) {
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <a href="/" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }} title="Home">
            <img src="/darios-logo.png" alt="Darios" style={{ height: 28, objectFit: 'contain' }} />
          </a>
          <span style={{ color: '#64748b', fontSize: 12 }}>Purchase Order</span>
          <a href="/" style={{ marginLeft: 'auto', color: '#475569', fontSize: 13, textDecoration: 'none', padding: '4px 10px', borderRadius: 6, border: '1px solid #334155' }}>
            🏠 Home
          </a>
        </div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{title}</h2>
      </div>
    );
  }

  // ── Step 1: Job search ─────────────────────────────────────────────────────
  if (step === 1) return (
    <div style={wrap}>
      {header('Find a Job')}

      <div style={card}>
        <div style={label}>Search by job name or work ticket #</div>
        <input
          style={inp} placeholder="e.g. Smith backyard or ticket #24879"
          value={jobQuery} onChange={e => setJobQuery(e.target.value)}
          autoFocus
        />
        {jobLoading && <div style={{ color: '#64748b', fontSize: 13, marginTop: 8 }}>Searching…</div>}

        {jobResults.length > 0 && (
          <div style={{ marginTop: 10 }}>
            {jobResults.map((j, i) => (
              <div key={i} style={row} onClick={() => selectJob(j)}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{j.opportunity_name}</div>
                  {j.property_name && (
                    <div style={{ color: '#94a3b8', fontSize: 12 }}>{j.property_name}</div>
                  )}
                  {j.work_ticket_num && (
                    <div style={{ color: '#64748b', fontSize: 11 }}>Ticket #{j.work_ticket_num} · {j.date}</div>
                  )}
                </div>
                <span style={{ color: '#475569' }}>›</span>
              </div>
            ))}
          </div>
        )}

        {jobQuery.length > 1 && !jobLoading && jobResults.length === 0 && (
          <div style={{ color: '#64748b', fontSize: 13, marginTop: 8 }}>No jobs found.</div>
        )}
      </div>

      <div style={card}>
        <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 10 }}>
          Buying irrigation inventory with no specific job?
        </div>
        <button style={{ ...btn('#7c3aed') }} onClick={skipJob}>
          📦 No Job — Inventory Purchase
        </button>
      </div>
    </div>
  );

  // ── Step 2: Pick work ticket ───────────────────────────────────────────────
  if (step === 2) return (
    <div style={wrap}>
      {header('Select Work Ticket')}

      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{selectedJob?.opportunity_name}</div>
        {selectedJob?.property_name && (
          <div style={{ color: '#94a3b8', fontSize: 13 }}>{selectedJob.property_name}</div>
        )}
      </div>

      {ticketsLoading && <div style={{ color: '#64748b', fontSize: 14, padding: 16 }}>Loading tickets…</div>}

      {!ticketsLoading && workTickets.length === 0 && (
        <div style={{ ...card, color: '#94a3b8' }}>
          No open work tickets found for this job.
        </div>
      )}

      {!ticketsLoading && workTickets.map(t => (
        <div key={t.WorkTicketID}
          style={{
            ...row,
            border: selectedTicket?.WorkTicketID === t.WorkTicketID
              ? `2px solid ${GRN}` : '1px solid #334155',
          }}
          onClick={() => { setSelectedTicket(t); fetchTicketItems(t.WorkTicketID); }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>Ticket #{t.WorkTicketNumber}</div>
            {t.WorkTicketTitle && (
              <div style={{ color: '#e2e8f0', fontSize: 13 }}>{t.WorkTicketTitle}</div>
            )}
            <div style={{ color: '#94a3b8', fontSize: 12 }}>
              {t.ScheduledStartDate?.slice(0, 10)} · {t.WorkTicketStatusName}
            </div>
          </div>
          {selectedTicket?.WorkTicketID === t.WorkTicketID && (
            <span style={{ color: GRN, fontSize: 18 }}>✓</span>
          )}
        </div>
      ))}

      <button style={btn()} disabled={!selectedTicket && workTickets.length > 0}
        onClick={() => setStep(3)}>
        {selectedTicket
          ? `Continue with #${selectedTicket.WorkTicketNumber}${selectedTicket.WorkTicketTitle ? ' — ' + selectedTicket.WorkTicketTitle : ''}`
          : 'Skip — No ticket'}
      </button>
      <button style={ghost} onClick={() => { setStep(1); setSelectedJob(null); setWorkTickets([]); }}>
        ← Back
      </button>
    </div>
  );

  // ── Step 3: Vendor picker ──────────────────────────────────────────────────
  if (step === 3) return (
    <div style={wrap}>
      {header('Select Vendor')}

      {/* Job summary */}
      {selectedJob && (
        <div style={{ ...card, padding: '10px 14px', marginBottom: 8 }}>
          <span style={{ color: '#64748b', fontSize: 12 }}>Job: </span>
          <span style={{ fontSize: 13 }}>{selectedJob.opportunity_name}</span>
          {selectedTicket && pill(`Ticket #${selectedTicket.WorkTicketNumber}`)}
        </div>
      )}
      {inventoryOnly && (
        <div style={{ ...card, padding: '10px 14px', marginBottom: 8 }}>
          <span style={{ fontSize: 13 }}>📦 Inventory purchase — no job attached</span>
        </div>
      )}

      <div style={card}>
        <div style={label}>Search vendors</div>
        <input
          style={inp} placeholder="Type to search…"
          value={vendorQuery} onChange={e => setVendorQuery(e.target.value)}
        />
        {vendorLoading && <div style={{ color: '#64748b', fontSize: 13, marginTop: 6 }}>Searching…</div>}

        {!vendorQuery && vendors.length > 0 && (
          <div style={{ color: '#64748b', fontSize: 11, margin: '8px 0 4px' }}>PREFERRED VENDORS</div>
        )}

        <div style={{ marginTop: 8 }}>
          {vendors.map((v, i) => (
            <div key={i}
              style={{
                ...row,
                border: selectedVendor?.vendor_name === v.vendor_name
                  ? `2px solid ${GRN}` : '1px solid #334155',
                opacity: v.vendor_id ? 1 : 0.55,
              }}
              onClick={() => v.vendor_id && setSelectedVendor(v)}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{v.vendor_name}</div>
                {!v.vendor_id && (
                  <div style={{ color: '#ef4444', fontSize: 11 }}>Not found in Aspire</div>
                )}
              </div>
              {selectedVendor?.vendor_name === v.vendor_name
                ? <span style={{ color: GRN, fontSize: 18 }}>✓</span>
                : <span style={{ color: '#475569' }}>›</span>
              }
            </div>
          ))}
          {vendors.length === 0 && vendorQuery && !vendorLoading && (
            <div style={{ color: '#64748b', fontSize: 13 }}>No vendors found.</div>
          )}
        </div>
      </div>

      <button style={btn()} disabled={!selectedVendor}
        onClick={() => setStep(4)}>
        {selectedVendor ? `Continue with ${selectedVendor.vendor_name}` : 'Select a vendor to continue'}
      </button>
      <button style={ghost} onClick={() => setStep(inventoryOnly ? 1 : 2)}>← Back</button>
    </div>
  );

  // ── Step 4: Line items ─────────────────────────────────────────────────────
  if (step === 4) return (
    <div style={wrap}>
      {header('Add Items')}

      <div style={{ ...card, padding: '10px 14px', marginBottom: 8 }}>
        <span style={{ color: '#64748b', fontSize: 12 }}>Vendor: </span>
        <span style={{ fontSize: 13 }}>{selectedVendor?.vendor_name}</span>
        {selectedJob && <span style={{ color: '#64748b', fontSize: 12 }}> · {selectedJob.opportunity_name}</span>}
      </div>

      {/* Load from ticket banner */}
      {selectedTicket && (
        <div style={{ ...card, background: '#1e3a5f', border: '1px solid #3b82f6', padding: '12px 14px', marginBottom: 8 }}>
          {ticketItemsLoading && (
            <div style={{ color: '#93c5fd', fontSize: 13 }}>Loading ticket materials…</div>
          )}
          {!ticketItemsLoading && ticketItems.length > 0 && (
            <div>
              <div style={{ color: '#93c5fd', fontSize: 12, marginBottom: 6 }}>
                📋 Ticket #{selectedTicket.WorkTicketNumber}{selectedTicket.WorkTicketTitle ? ' — ' + selectedTicket.WorkTicketTitle : ''} · {ticketItems.length} material item{ticketItems.length !== 1 ? 's' : ''}:
              </div>
              {ticketItems.map((ti, i) => (
                <div key={i} style={{ color: '#bfdbfe', fontSize: 13, marginBottom: 2 }}>
                  · {ti.name} × {ti.qty}{ti.uom ? ` ${ti.uom}` : ''}
                </div>
              ))}
              <button
                style={{ ...btn(BLU), marginTop: 10, fontSize: 14, padding: '10px' }}
                onClick={loadTicketItemsIntoForm}
              >
                ↓ Load these items into PO
              </button>
            </div>
          )}
          {!ticketItemsLoading && ticketItems.length === 0 && (
            <div style={{ color: '#64748b', fontSize: 13 }}>No purchasable materials on this ticket.</div>
          )}
        </div>
      )}

      {items.map((it, i) => (
        <div key={i} style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 600 }}>Item {i + 1}</span>
            {items.length > 1 && (
              <button onClick={() => removeItem(i)}
                style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 13 }}>
                Remove
              </button>
            )}
          </div>

          <div style={label}>Description</div>
          <div style={{ position: 'relative', marginBottom: 10 }}>
            <input
              style={inp}
              placeholder="Search catalogue or type description…"
              value={it.description}
              onChange={e => {
                updateItem(i, 'description', e.target.value);
                const q = e.target.value;
                if (catalogTimers.current[i]) clearTimeout(catalogTimers.current[i]!);
                if (q.length < 2) {
                  setCatalogResults(r => { const n = [...r]; n[i] = []; return n; });
                  return;
                }
                setCatalogLoading(l => { const n = [...l]; n[i] = true; return n; });
                catalogTimers.current[i] = setTimeout(async () => {
                  const results = await searchCatalogItems(q);
                  setCatalogResults(r => { const n = [...r]; n[i] = results; return n; });
                  setCatalogLoading(l => { const n = [...l]; n[i] = false; return n; });
                }, 350);
              }}
            />
            {catalogLoading[i] && (
              <div style={{ position: 'absolute', right: 10, top: 10, color: '#94a3b8', fontSize: 12 }}>searching…</div>
            )}
            {catalogResults[i]?.length > 0 && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                background: '#1e293b', border: '1px solid #334155', borderRadius: 8,
                maxHeight: 220, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
              }}>
                {catalogResults[i].map(cat => (
                  <div key={cat.id}
                    onClick={() => {
                      updateItem(i, 'description', cat.name);
                      updateItem(i, 'unit_cost', cat.unit_cost);
                      if (cat.uom) updateItem(i, 'uom', cat.uom);
                      setCatalogResults(r => { const n = [...r]; n[i] = []; return n; });
                    }}
                    style={{
                      padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid #0f172a',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#334155')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div style={{ color: '#f1f5f9', fontSize: 14, fontWeight: 600 }}>{cat.name}</div>
                    <div style={{ color: '#94a3b8', fontSize: 12 }}>
                      {cat.code && <span style={{ marginRight: 10 }}>{cat.code}</span>}
                      {cat.uom && <span style={{ marginRight: 10 }}>{cat.uom}</span>}
                      {cat.unit_cost > 0 && <span>${cat.unit_cost.toFixed(2)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <div style={label}>Qty</div>
              <input
                style={inp} type="number" min="0.01" step="0.01"
                value={it.qty || ''}
                onChange={e => updateItem(i, 'qty', e.target.value)}
              />
            </div>
            <div>
              <div style={label}>UOM</div>
              <select
                style={inp}
                value={it.uom || ''}
                onChange={e => updateItem(i, 'uom', e.target.value)}
              >
                <option value="">— select —</option>
                {uomTypes.map(u => (
                  <option key={u.id} value={u.name}>{u.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Unit cost — read-only, populated from catalogue selection */}
          {it.unit_cost > 0 && (
            <div style={{ marginTop: 8, color: '#64748b', fontSize: 12 }}>
              Unit cost: <strong style={{ color: '#e2e8f0' }}>${it.unit_cost.toFixed(2)}</strong>
              {it.qty > 0 && (
                <span style={{ marginLeft: 10 }}>
                  · Total: <strong style={{ color: GRN }}>${(it.qty * it.unit_cost).toFixed(2)}</strong>
                </span>
              )}
            </div>
          )}
        </div>
      ))}

      {items.length < 5 && (
        <button style={{ ...ghost, marginBottom: 8 }} onClick={addItem}>+ Add another item</button>
      )}

      <button style={btn()} disabled={validItems.length === 0}
        onClick={() => setStep(5)}>
        Continue
      </button>
      <button style={ghost} onClick={() => setStep(3)}>← Back</button>
    </div>
  );

  // ── Step 5: Notes + name ───────────────────────────────────────────────────
  if (step === 5) return (
    <div style={wrap}>
      {header('Notes & Your Name')}

      <div style={card}>
        <div style={label}>Notes (optional)</div>
        <textarea
          style={{ ...inp, height: 90, resize: 'none' }}
          placeholder="Any special instructions, urgency, delivery notes…"
          value={notes}
          onChange={e => setNotes(e.target.value)}
        />
      </div>

      <div style={card}>
        <div style={label}>Your name</div>
        <select
          style={inp}
          value={empName}
          onChange={e => setEmpName(e.target.value)}
        >
          <option value="">— Select your name —</option>
          {employees.map(emp => (
            <option key={emp.ContactID} value={emp.FullName}>{emp.FullName}</option>
          ))}
        </select>
      </div>

      <button style={btn()} disabled={!empName} onClick={() => setStep(6)}>
        Review PO
      </button>
      <button style={ghost} onClick={() => setStep(4)}>← Back</button>
    </div>
  );

  // ── Step 6: Review & submit ────────────────────────────────────────────────
  if (step === 6) return (
    <div style={wrap}>
      {header('Review & Submit')}

      <div style={card}>
        <div style={{ borderBottom: '1px solid #334155', paddingBottom: 10, marginBottom: 10 }}>
          <div style={label}>Requested by</div>
          <div style={{ fontWeight: 600 }}>{empName}</div>
        </div>

        <div style={{ borderBottom: '1px solid #334155', paddingBottom: 10, marginBottom: 10 }}>
          <div style={label}>Vendor</div>
          <div style={{ fontWeight: 600 }}>{selectedVendor?.vendor_name}</div>
        </div>

        {selectedJob && (
          <div style={{ borderBottom: '1px solid #334155', paddingBottom: 10, marginBottom: 10 }}>
            <div style={label}>Job</div>
            <div style={{ fontWeight: 600 }}>{selectedJob.opportunity_name}</div>
            {selectedTicket && (
              <div style={{ color: '#94a3b8', fontSize: 13 }}>Ticket #{selectedTicket.WorkTicketNumber}</div>
            )}
          </div>
        )}

        {inventoryOnly && (
          <div style={{ borderBottom: '1px solid #334155', paddingBottom: 10, marginBottom: 10 }}>
            <div style={label}>Type</div>
            <div style={{ fontWeight: 600 }}>📦 Inventory purchase</div>
          </div>
        )}

        <div style={{ marginBottom: 10 }}>
          <div style={label}>Items</div>
          {validItems.map((it, i) => (
            <div key={i} style={{ fontSize: 14, padding: '6px 0', borderBottom: '1px solid #0f172a', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <span style={{ flex: 1 }}>
                {it.description}
                <span style={{ color: '#94a3b8', marginLeft: 8 }}>× {it.qty}{it.uom ? ` ${it.uom}` : ''}</span>
              </span>
              {it.unit_cost > 0 && (
                <span style={{ color: '#e2e8f0', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  ${(it.qty * it.unit_cost).toFixed(2)}
                </span>
              )}
            </div>
          ))}
          {validItems.some(it => it.unit_cost > 0) && (
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8, fontWeight: 700, fontSize: 15 }}>
              <span style={{ color: '#94a3b8' }}>Total</span>
              <span style={{ color: GRN }}>
                ${validItems.reduce((s, it) => s + it.qty * (it.unit_cost || 0), 0).toFixed(2)}
              </span>
            </div>
          )}
        </div>

        {notes && (
          <div>
            <div style={label}>Notes</div>
            <div style={{ color: '#94a3b8', fontSize: 13 }}>{notes}</div>
          </div>
        )}
      </div>

      {error && (
        <div style={{ background: '#450a0a', border: '1px solid #ef4444',
          borderRadius: 8, padding: 12, marginBottom: 8, color: '#fca5a5', fontSize: 14 }}>
          {error}
        </div>
      )}

      <button style={btn(GRN)} disabled={submitting} onClick={submit}>
        {submitting ? 'Submitting…' : '✅ Submit Purchase Order'}
      </button>
      <button style={ghost} onClick={() => setStep(5)}>← Back</button>
    </div>
  );

  // ── Step 7: Success ────────────────────────────────────────────────────────
  if (step === 7) return (
    <div style={wrap}>
      <div style={{ textAlign: 'center', padding: '40px 16px' }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>✅</div>
        <h2 style={{ margin: '0 0 8px', fontSize: 24 }}>PO Created!</h2>
        {(result?.display_number ?? result?.receipt_id) != null && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ color: '#64748b', fontSize: 13 }}>PO Reference Number</div>
            <div style={{ fontSize: 36, fontWeight: 800, color: GRN, letterSpacing: 2 }}>
              #{result?.display_number ?? result?.receipt_id}
            </div>
          </div>
        )}
        <div style={{ background: CARD, borderRadius: 12, padding: 16, marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ color: '#64748b' }}>Vendor</span>
            <span>{selectedVendor?.vendor_name}</span>
          </div>
          {selectedJob && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ color: '#64748b' }}>Job</span>
              <span style={{ textAlign: 'right', maxWidth: '60%' }}>{selectedJob.opportunity_name}</span>
            </div>
          )}
          {selectedTicket && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#64748b' }}>Work Ticket</span>
              <span>#{selectedTicket.WorkTicketNumber}</span>
            </div>
          )}
        </div>

        <div style={{ color: '#64748b', fontSize: 13, marginBottom: 24 }}>
          Give PO #{result?.display_number ?? result?.receipt_id} to the vendor as your reference number.
          The purchase order is now in Aspire.
        </div>

        <button style={btn(BLU)} onClick={() => {
          setStep(1);
          setSelectedJob(null); setSelectedTicket(null);
          setInventoryOnly(false); setSelectedVendor(null);
          setItems([{ ...EMPTY_ITEM }]); setNotes(''); setEmpName('');
          setJobQuery(''); setVendorQuery('');
          setResult(null); setError('');
        }}>
          + Create Another PO
        </button>
        <a href="/" style={{ display: 'block', textAlign: 'center', color: '#475569', fontSize: 14, marginTop: 16, textDecoration: 'none' }}>
          🏠 Back to Home
        </a>
      </div>
    </div>
  );

  return null;
}
