/**
 * TimeTracking.tsx — Mobile-first crew time tracking.
 *
 * Flow:
 *  1. PIN entry → match employee → store in localStorage for the day
 *  2. Main screen: Clock In → segment controls → Clock Out → Submit to Aspire
 *
 * No login required — this page is accessed directly on crew phones.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const BASE = import.meta.env.VITE_API_URL || 'https://ap-automation-production.up.railway.app';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CrewMember {
  ContactID:   number;
  FullName:    string;
  Email:       string;
  MobilePhone: string;
  EmployeePin: string;
}

interface TimeSession {
  id:                     number;
  work_date:              string;
  employee_id:            number;
  employee_name:          string;
  clock_in:               string | null;
  clock_out:              string | null;
  break_minutes:          number;
  status:                 'draft' | 'submitted' | 'error';
  submitted_at:           string | null;
  notes:                  string | null;
  created_at:             string;
  route_id:               number | null;
  route_name:             string | null;
  crew_leader_contact_id: number | null;
  crew_leader_name:       string | null;
}

interface TimeSegment {
  id:               number;
  session_id:       number;
  segment_type:     'onsite' | 'drive' | 'lunch';
  work_ticket_id:   number | null;
  work_ticket_num:  string | null;
  work_ticket_name: string | null;
  start_time:       string;
  end_time:         string | null;
  duration_minutes: number | null;
  aspire_wtt_id:    string | null;
}

interface WorkTicket {
  WorkTicketID:     number;
  WorkTicketNumber: string | null;
  WorkTicketTitle:  string;
  OpportunityName:  string;
  PropertyName:     string;
  ScheduledDate:    string | null;
  HoursEst:         number | null;
  _RouteName:       string;
}

interface DriveTicket {
  ticket_id:    number | null;
  ticket_num:   string | null;
  ticket_name:  string | null;
  ticket_month: string | null;
}

interface RouteInfo {
  route_id:               number | null;
  route_name:             string | null;
  crew_leader_contact_id: number | null;
  crew_leader_name:       string | null;
}

interface AspireRoute {
  RouteID:                 number;
  RouteName:               string | null;
  CrewLeaderContactID:     number | null;
  CrewLeaderContactName:   string | null;
}

// ── Local-storage session state ───────────────────────────────────────────────

interface StoredSession {
  employee_id:            number;
  employee_name:          string;
  session_id:             number | null;
  work_date:              string;
  route_id?:              number | null;
  route_name?:            string | null;
  crew_leader_contact_id?: number | null;
  crew_leader_name?:      string | null;
}

const LS_KEY = 'time_tracking_session';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Convert an HH:MM string (in the browser's local timezone) + a YYYY-MM-DD
 * work date into a proper UTC ISO-8601 string.
 * Using new Date(y, m-1, d, h, min) always interprets args as LOCAL time,
 * then .toISOString() converts correctly to UTC.
 */
function localHHMMtoUTCIso(hhmm: string, workDate: string): string {
  const [year, month, day]   = workDate.split('-').map(Number);
  const [hours, minutes]     = hhmm.split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString();
}

function loadStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed: StoredSession = JSON.parse(raw);
    // Only valid if it's from today
    if (parsed.work_date !== todayISO()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveStoredSession(s: StoredSession) {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

function clearStoredSession() {
  localStorage.removeItem(LS_KEY);
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Elapsed-time hook ─────────────────────────────────────────────────────────

function useElapsed(startIso: string | null): string {
  const [elapsed, setElapsed] = useState('0:00');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!startIso) { setElapsed('0:00'); return; }
    const update = () => {
      const diff = Math.max(0, Date.now() - new Date(startIso).getTime());
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1_000);
      setElapsed(h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`);
    };
    update();
    timerRef.current = setInterval(update, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [startIso]);

  return elapsed;
}

// ── Format helpers ────────────────────────────────────────────────────────────

function fmtTime(iso: string | null): string {
  if (!iso) return '--:--';
  return new Date(iso).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function fmtDuration(minutes: number | null): string {
  if (minutes === null || minutes === undefined) return '--';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-CA', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

// ── Shared ticket row ─────────────────────────────────────────────────────────

function TicketRow({ ticket: t, onSelect, highlight }: {
  ticket: WorkTicket;
  onSelect: (t: WorkTicket) => void;
  highlight?: boolean;
}) {
  return (
    <button
      onClick={() => onSelect(t)}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '14px 20px', background: highlight ? '#f0f9ff' : 'none',
        border: 'none', borderBottom: '1px solid #f1f5f9', cursor: 'pointer',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 15, color: '#0f172a' }}>
        {t.OpportunityName || t.WorkTicketTitle || `Ticket #${t.WorkTicketNumber || t.WorkTicketID}`}
      </div>
      {t.PropertyName && (
        <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>{t.PropertyName}</div>
      )}
      <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
        #{t.WorkTicketNumber || t.WorkTicketID} · {t._RouteName || ''}
        {t.ScheduledDate ? ` · ${fmtDate(t.ScheduledDate.slice(0, 10))}` : ''}
      </div>
    </button>
  );
}

// ── Ticket picker modal ───────────────────────────────────────────────────────

interface TicketPickerProps {
  tickets:    WorkTicket[];
  loading:    boolean;
  routeName?: string | null;   // active route — used to pin route tickets to top
  onSelect:   (t: WorkTicket) => void;
  onManual:   (id: string, num: string, name: string) => void;
  onClose:    () => void;
}

function TicketPicker({ tickets, loading, routeName, onSelect, onManual, onClose }: TicketPickerProps) {
  const [query,      setQuery]      = useState('');
  const [manualId,   setManualId]   = useState('');
  const [manualNum,  setManualNum]  = useState('');
  const [manualName, setManualName] = useState('');

  const matchesRoute = (t: WorkTicket) =>
    routeName
      ? (t._RouteName || '').toLowerCase().trim() === routeName.toLowerCase().trim()
      : false;

  const allFiltered = query.trim()
    ? tickets.filter(t =>
        (t.OpportunityName || '').toLowerCase().includes(query.toLowerCase()) ||
        (t.PropertyName    || '').toLowerCase().includes(query.toLowerCase()) ||
        (t.WorkTicketTitle || '').toLowerCase().includes(query.toLowerCase()) ||
        String(t.WorkTicketNumber || t.WorkTicketID).includes(query)
      )
    : tickets;

  // When not searching: split into route tickets + others
  const routeTickets = query.trim() ? [] : allFiltered.filter(matchesRoute);
  const otherTickets = query.trim() ? allFiltered : allFiltered.filter(t => !matchesRoute(t));
  const hasRouteSplit = !query.trim() && routeTickets.length > 0;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      zIndex: 200, display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        background: '#fff', flex: 1, display: 'flex', flexDirection: 'column',
        marginTop: 40, borderRadius: '16px 16px 0 0', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: '1px solid #e2e8f0',
          background: '#f8fafc',
        }}>
          <span style={{ fontWeight: 700, fontSize: 18 }}>Select Work Ticket</span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', fontSize: 24, cursor: 'pointer',
            color: '#64748b', lineHeight: 1,
          }}>×</button>
        </div>

        {/* Search */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0' }}>
          <input
            type="search"
            placeholder="Search by name, property, or ticket #…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
            style={{
              width: '100%', padding: '12px 14px', fontSize: 16,
              border: '2px solid #cbd5e1', borderRadius: 10, outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Ticket list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {loading && (
            <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>Loading tickets…</div>
          )}
          {!loading && allFiltered.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>No tickets found</div>
          )}

          {/* ── Route tickets pinned to top ── */}
          {hasRouteSplit && (
            <>
              <div style={{
                padding: '8px 20px 4px', fontSize: 11, fontWeight: 700,
                color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: 0.8,
                background: '#eff6ff', borderBottom: '1px solid #bfdbfe',
              }}>
                🗺️ {routeName} — Today's stops
              </div>
              {routeTickets.map(t => (
                <TicketRow key={t.WorkTicketID} ticket={t} onSelect={onSelect} highlight />
              ))}
              {otherTickets.length > 0 && (
                <div style={{
                  padding: '8px 20px 4px', fontSize: 11, fontWeight: 700,
                  color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.8,
                  background: '#f8fafc', borderBottom: '1px solid #e2e8f0',
                  borderTop: '2px solid #e2e8f0',
                }}>
                  Other routes
                </div>
              )}
            </>
          )}

          {/* ── All tickets (search mode or no route split) ── */}
          {otherTickets.map(t => (
            <TicketRow key={t.WorkTicketID} ticket={t} onSelect={onSelect} />
          ))}
        </div>

        {/* Manual entry */}
        <div style={{
          padding: 16, borderTop: '2px solid #e2e8f0', background: '#f8fafc',
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 8 }}>
            Enter ticket manually
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              type="number"
              placeholder="Ticket ID"
              value={manualId}
              onChange={e => setManualId(e.target.value)}
              style={{
                flex: '0 0 110px', padding: '10px 12px', fontSize: 15,
                border: '1px solid #cbd5e1', borderRadius: 8,
              }}
            />
            <input
              type="text"
              placeholder="Ticket # (optional)"
              value={manualNum}
              onChange={e => setManualNum(e.target.value)}
              style={{
                flex: '0 0 140px', padding: '10px 12px', fontSize: 15,
                border: '1px solid #cbd5e1', borderRadius: 8,
              }}
            />
            <input
              type="text"
              placeholder="Description"
              value={manualName}
              onChange={e => setManualName(e.target.value)}
              style={{
                flex: 1, minWidth: 120, padding: '10px 12px', fontSize: 15,
                border: '1px solid #cbd5e1', borderRadius: 8,
              }}
            />
            <button
              onClick={() => {
                if (!manualId) return;
                onManual(manualId, manualNum, manualName || `Ticket #${manualId}`);
              }}
              disabled={!manualId}
              style={{
                padding: '10px 18px', background: '#0f172a', color: '#fff',
                border: 'none', borderRadius: 8, fontSize: 15, cursor: 'pointer',
                opacity: manualId ? 1 : 0.4,
              }}
            >
              Use
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Drive-ticket settings modal ───────────────────────────────────────────────

interface DriveTicketSettingsProps {
  current:  DriveTicket;
  onSave:   (dt: DriveTicket) => void;
  onClose:  () => void;
}

function DriveTicketSettings({ current, onSave, onClose }: DriveTicketSettingsProps) {
  const [query,    setQuery]    = useState('');
  const [chosen,   setChosen]   = useState<DriveTicket>(current);
  const [tickets,  setTickets]  = useState<WorkTicket[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [searched, setSearched] = useState(false);

  // Auto-load all tickets (±3 month window) on open
  useEffect(() => {
    setLoading(true);
    setSearched(false);
    apiFetch<{ work_tickets: WorkTicket[] }>('GET', '/time/work-tickets/search')
      .then(r => { setTickets(r.work_tickets || []); setSearched(true); })
      .catch(() => setSearched(true))
      .finally(() => setLoading(false));
  }, []);

  const handleSearch = () => {
    setLoading(true);
    apiFetch<{ work_tickets: WorkTicket[] }>('GET', `/time/work-tickets/search?q=${encodeURIComponent(query)}`)
      .then(r => setTickets(r.work_tickets || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const filtered = query.trim()
    ? tickets.filter(t =>
        (t.OpportunityName || '').toLowerCase().includes(query.toLowerCase()) ||
        (t.WorkTicketTitle || '').toLowerCase().includes(query.toLowerCase()) ||
        String(t.WorkTicketNumber || t.WorkTicketID).includes(query)
      )
    : tickets;

  const thisMonth = new Date().toISOString().slice(0, 7);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      zIndex: 200, display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        background: '#fff', flex: 1, display: 'flex', flexDirection: 'column',
        marginTop: 40, borderRadius: '16px 16px 0 0', overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: '1px solid #e2e8f0', background: '#f8fafc',
        }}>
          <span style={{ fontWeight: 700, fontSize: 18 }}>Set Monthly Drive Ticket</span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: '#64748b',
          }}>×</button>
        </div>

        {chosen.ticket_id && (
          <div style={{
            padding: '12px 20px', background: '#eff6ff', borderBottom: '1px solid #bfdbfe',
          }}>
            <div style={{ fontWeight: 600, color: '#1d4ed8' }}>
              Selected: {chosen.ticket_name}
            </div>
            <div style={{ fontSize: 13, color: '#3b82f6' }}>
              ID {chosen.ticket_id} · #{chosen.ticket_num} · Month {chosen.ticket_month}
            </div>
          </div>
        )}

        <div style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0', display: 'flex', gap: 8 }}>
          <input
            type="search"
            placeholder="Search all tickets…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
            autoFocus
            style={{
              flex: 1, padding: '12px 14px', fontSize: 16,
              border: '2px solid #cbd5e1', borderRadius: 10, outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          <button
            onClick={handleSearch}
            disabled={loading}
            style={{
              padding: '0 16px', background: '#1d4ed8', color: '#fff',
              border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 15,
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {loading ? '…' : 'Search'}
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {loading && <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>Loading…</div>}
          {!loading && searched && filtered.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8' }}>
              No tickets found. Try searching by ticket # or name.
            </div>
          )}
          {filtered.map(t => (
            <button
              key={t.WorkTicketID}
              onClick={() => setChosen({
                ticket_id:    t.WorkTicketID,
                ticket_num:   String(t.WorkTicketNumber || t.WorkTicketID),
                ticket_name:  t.OpportunityName || t.WorkTicketTitle || `#${t.WorkTicketID}`,
                ticket_month: thisMonth,
              })}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '14px 20px', background: chosen.ticket_id === t.WorkTicketID ? '#eff6ff' : 'none',
                border: 'none', borderBottom: '1px solid #f1f5f9', cursor: 'pointer',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 15 }}>
                {t.OpportunityName || t.WorkTicketTitle || `Ticket #${t.WorkTicketID}`}
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
                #{t.WorkTicketNumber || t.WorkTicketID}
              </div>
            </button>
          ))}
        </div>

        <div style={{ padding: 16, borderTop: '2px solid #e2e8f0', background: '#f8fafc' }}>
          <button
            onClick={() => chosen.ticket_id && onSave(chosen)}
            disabled={!chosen.ticket_id}
            style={{
              width: '100%', padding: 16, fontSize: 16, fontWeight: 700,
              background: '#1d4ed8', color: '#fff', border: 'none',
              borderRadius: 12, cursor: 'pointer', opacity: chosen.ticket_id ? 1 : 0.4,
            }}
          >
            Save Drive Ticket
          </button>
        </div>
      </div>
    </div>
  );
}

// ── EditTimesModal — edit start + end on a completed segment ──────────────────
function EditTimesModal({ title, initStart, initEnd, onSave, onClose }: {
  title: string;
  initStart: string;
  initEnd:   string;
  onSave: (start: string, end: string) => void;
  onClose: () => void;
}) {
  const [start, setStart] = useState(initStart);
  const [end,   setEnd]   = useState(initEnd);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      zIndex: 300, display: 'flex', alignItems: 'flex-end',
    }}>
      <div style={{
        background: '#fff', width: '100%', borderRadius: '18px 18px 0 0',
        padding: 24, paddingBottom: 36,
      }}>
        <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 4 }}>✏️ Edit Times</div>
        <div style={{ fontSize: 13, color: '#64748b', marginBottom: 20 }}>{title}</div>
        <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
          <label style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 6 }}>START</div>
            <input type="time" value={start} onChange={e => setStart(e.target.value)}
              style={{ width: '100%', fontSize: 22, padding: '10px 12px', borderRadius: 10,
                border: '2px solid #cbd5e1', fontWeight: 700, boxSizing: 'border-box' }} />
          </label>
          <label style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 6 }}>END</div>
            <input type="time" value={end} onChange={e => setEnd(e.target.value)}
              style={{ width: '100%', fontSize: 22, padding: '10px 12px', borderRadius: 10,
                border: '2px solid #cbd5e1', fontWeight: 700, boxSizing: 'border-box' }} />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={onClose} style={{
            flex: 1, padding: 14, borderRadius: 12, border: '1.5px solid #cbd5e1',
            background: '#fff', fontSize: 16, fontWeight: 600, cursor: 'pointer', color: '#475569',
          }}>Cancel</button>
          <button onClick={() => start && end && onSave(start, end)} disabled={!start || !end}
            style={{
              flex: 2, padding: 14, borderRadius: 12, border: 'none',
              background: start && end ? '#0f172a' : '#e2e8f0',
              color: start && end ? '#fff' : '#94a3b8',
              fontSize: 16, fontWeight: 700, cursor: start && end ? 'pointer' : 'default',
            }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── EditSingleTimeModal — edit one time (clock-in or clock-out) ───────────────
function EditSingleTimeModal({ title, initValue, onSave, onClose }: {
  title: string;
  initValue: string;
  onSave: (hhmm: string) => void;
  onClose: () => void;
}) {
  const [val, setVal] = useState(initValue);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      zIndex: 300, display: 'flex', alignItems: 'flex-end',
    }}>
      <div style={{
        background: '#fff', width: '100%', borderRadius: '18px 18px 0 0',
        padding: 24, paddingBottom: 36,
      }}>
        <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 20 }}>✏️ {title}</div>
        <input type="time" value={val} onChange={e => setVal(e.target.value)}
          style={{ width: '100%', fontSize: 28, padding: '12px 16px', borderRadius: 12,
            border: '2px solid #cbd5e1', fontWeight: 700, marginBottom: 24,
            boxSizing: 'border-box', textAlign: 'center' }} />
        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={onClose} style={{
            flex: 1, padding: 14, borderRadius: 12, border: '1.5px solid #cbd5e1',
            background: '#fff', fontSize: 16, fontWeight: 600, cursor: 'pointer', color: '#475569',
          }}>Cancel</button>
          <button onClick={() => val && onSave(val)} disabled={!val}
            style={{
              flex: 2, padding: 14, borderRadius: 12, border: 'none',
              background: val ? '#0f172a' : '#e2e8f0',
              color: val ? '#fff' : '#94a3b8',
              fontSize: 16, fontWeight: 700, cursor: val ? 'pointer' : 'default',
            }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TimeTracking() {
  const today = todayISO();

  // ── Auth state
  const [phase,        setPhase]        = useState<'pin' | 'route' | 'main'>('pin');
  const [pinInput,     setPinInput]      = useState('');
  const [pinError,     setPinError]      = useState<string | null>(null);
  const [crewMembers,  setCrewMembers]   = useState<CrewMember[]>([]);
  const [crewLoading,  setCrewLoading]   = useState(false);
  const [employee,     setEmployee]      = useState<CrewMember | null>(null);

  // ── Route state
  const [routeInfo,         setRouteInfo]         = useState<RouteInfo | null>(null);
  const [routeAutoDetected, setRouteAutoDetected] = useState(false);
  const [allRoutes,         setAllRoutes]         = useState<AspireRoute[]>([]);
  const [routeLoading,      setRouteLoading]      = useState(false);

  // ── Session state
  const [session,  setSession]  = useState<TimeSession | null>(null);
  const [segments, setSegments] = useState<TimeSegment[]>([]);
  const [sessionLoading, setSessionLoading] = useState(false);

  // ── Tickets
  const [tickets,        setTickets]        = useState<WorkTicket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [driveTicket,    setDriveTicket]    = useState<DriveTicket>({
    ticket_id: null, ticket_num: null, ticket_name: null, ticket_month: null,
  });

  // ── UI state
  const [showTicketPicker, setShowTicketPicker] = useState(false);
  const [pickerMode,       setPickerMode]       = useState<'start' | 'switch'>('start');
  const [showDriveSettings, setShowDriveSettings] = useState(false);
  const [showHistory,      setShowHistory]      = useState(true);
  const [editSegment,      setEditSegment]      = useState<TimeSegment | null>(null);
  const [editClockField,   setEditClockField]   = useState<'in' | 'out' | null>(null);
  const [actionLoading,    setActionLoading]    = useState(false);
  const [submitError,      setSubmitError]      = useState<string | null>(null);
  const [submitOk,         setSubmitOk]         = useState(false);

  // Elapsed timer for active segment
  const openSegment = segments.find(s => !s.end_time) ?? null;
  const elapsed = useElapsed(openSegment?.start_time ?? null);

  // ── Load crew members on mount ────────────────────────────────────────────
  useEffect(() => {
    setCrewLoading(true);
    apiFetch<{ crew_members: CrewMember[] }>('GET', '/time/crew-members')
      .then(r => setCrewMembers(r.crew_members))
      .catch(e => console.error('crew-members:', e))
      .finally(() => setCrewLoading(false));
  }, []);

  // ── Restore localStorage session ──────────────────────────────────────────
  useEffect(() => {
    const stored = loadStoredSession();
    if (!stored) return;

    // We have a stored session — need crew member too
    // We'll restore employee once crew members are loaded
    if (stored.session_id) {
      setSessionLoading(true);
      apiFetch<{ session: TimeSession | null; segments: TimeSegment[] }>(
        'GET',
        `/time/session?employee_id=${stored.employee_id}&work_date=${stored.work_date}`
      )
        .then(r => {
          if (r.session) {
            setSession(r.session);
            setSegments(r.segments);
            // Restore route info from session
            if (r.session.route_id || r.session.route_name) {
              setRouteInfo({
                route_id:               r.session.route_id,
                route_name:             r.session.route_name,
                crew_leader_contact_id: r.session.crew_leader_contact_id,
                crew_leader_name:       r.session.crew_leader_name,
              });
            }
            // Restore employee from stored name — full object fetched after crew loads
            setEmployee({
              ContactID:   stored.employee_id,
              FullName:    stored.employee_name,
              Email:       '',
              MobilePhone: '',
              EmployeePin: '',
            });
            setPhase('main');
          } else {
            clearStoredSession();
          }
        })
        .catch(() => clearStoredSession())
        .finally(() => setSessionLoading(false));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Enrich employee from crew list once loaded ────────────────────────────
  useEffect(() => {
    if (!employee || crewMembers.length === 0) return;
    const full = crewMembers.find(m => m.ContactID === employee.ContactID);
    if (full) setEmployee(full);
  }, [crewMembers]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load work tickets and drive ticket when entering main phase ───────────
  useEffect(() => {
    if (phase !== 'main') return;
    setTicketsLoading(true);
    apiFetch<{ work_tickets: WorkTicket[] }>('GET', `/time/work-tickets?work_date=${today}`)
      .then(r => setTickets(r.work_tickets))
      .catch(e => console.error('work-tickets:', e))
      .finally(() => setTicketsLoading(false));

    apiFetch<DriveTicket>('GET', '/time/drive-ticket')
      .then(dt => setDriveTicket(dt))
      .catch(e => console.error('drive-ticket:', e));
  }, [phase, today]);

  // ── PIN submission ────────────────────────────────────────────────────────
  const handlePin = useCallback(async () => {
    setPinError(null);
    const pin = pinInput.trim();
    if (!pin) { setPinError('Enter your PIN'); return; }

    const pinLower = pin.toLowerCase();
    const match = crewMembers.find(m =>
      m.EmployeePin && m.EmployeePin.trim().toLowerCase() === pinLower
    );
    if (!match) {
      setPinError('PIN not recognised. Check with your supervisor.');
      setPinInput('');
      return;
    }

    setEmployee(match);

    // Check for existing session today
    setSessionLoading(true);
    try {
      const r = await apiFetch<{ session: TimeSession | null; segments: TimeSegment[] }>(
        'GET',
        `/time/session?employee_id=${match.ContactID}&work_date=${today}`
      );
      if (r.session) {
        setSession(r.session);
        setSegments(r.segments);
        // If session already has a route, restore it and skip route phase
        if (r.session.route_id || r.session.route_name) {
          setRouteInfo({
            route_id:               r.session.route_id,
            route_name:             r.session.route_name,
            crew_leader_contact_id: r.session.crew_leader_contact_id,
            crew_leader_name:       r.session.crew_leader_name,
          });
          saveStoredSession({
            employee_id: match.ContactID, employee_name: match.FullName,
            session_id: r.session.id, work_date: today,
          });
          setPhase('main');
          return;
        }
      }
    } catch (e) {
      console.error('session fetch:', e);
    } finally {
      setSessionLoading(false);
    }

    saveStoredSession({
      employee_id:   match.ContactID,
      employee_name: match.FullName,
      session_id:    null,
      work_date:     today,
    });

    // Fetch route assignment and all routes in parallel, then go to route phase
    setRouteLoading(true);
    try {
      const [myRouteRes, routesRes] = await Promise.all([
        apiFetch<{ route: RouteInfo | null; auto_detected: boolean }>(
          'GET', `/time/my-route?employee_id=${match.ContactID}&work_date=${today}`
        ),
        apiFetch<{ routes: AspireRoute[] }>('GET', '/time/routes'),
      ]);
      setAllRoutes(routesRes.routes ?? []);
      if (myRouteRes.route) {
        setRouteInfo(myRouteRes.route);
        setRouteAutoDetected(myRouteRes.auto_detected);
      }
    } catch (e) {
      console.error('route fetch:', e);
    } finally {
      setRouteLoading(false);
    }

    setPhase('route');
  }, [pinInput, crewMembers, today]);

  // (keypad removed — PIN is free-text)
  const handleKeypadPress = (_digit: string) => {
    // no-op
  };

  // ── Clock in ──────────────────────────────────────────────────────────────
  const handleClockIn = async () => {
    if (!employee) return;
    setActionLoading(true);
    try {
      const r = await apiFetch<{ session: TimeSession; segments: TimeSegment[] }>(
        'POST', '/time/clock-in',
        {
          employee_id:            employee.ContactID,
          employee_name:          employee.FullName,
          work_date:              today,
          route_id:               routeInfo?.route_id ?? null,
          route_name:             routeInfo?.route_name ?? null,
          crew_leader_contact_id: routeInfo?.crew_leader_contact_id ?? null,
          crew_leader_name:       routeInfo?.crew_leader_name ?? null,
        }
      );
      setSession(r.session);
      setSegments(r.segments);
      saveStoredSession({
        employee_id:   employee.ContactID,
        employee_name: employee.FullName,
        session_id:    r.session.id,
        work_date:     today,
      });
    } catch (e: unknown) {
      alert(`Clock-in failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActionLoading(false);
    }
  };

  // ── Start segment ─────────────────────────────────────────────────────────
  const startSegment = async (
    type: 'onsite' | 'drive' | 'lunch',
    wtId?: number, wtNum?: string, wtName?: string
  ) => {
    if (!session) return;
    setActionLoading(true);
    try {
      const r = await apiFetch<{ new_segment_id: number; segments: TimeSegment[] }>(
        'POST', '/time/segment/start',
        {
          session_id:       session.id,
          segment_type:     type,
          work_ticket_id:   wtId ?? null,
          work_ticket_num:  wtNum ?? null,
          work_ticket_name: wtName ?? null,
        }
      );
      setSegments(r.segments);
    } catch (e: unknown) {
      alert(`Failed to start segment: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActionLoading(false);
    }
  };

  // ── Segment button click ──────────────────────────────────────────────────
  const handleSegmentButton = (type: 'onsite' | 'drive' | 'lunch') => {
    if (!session?.clock_in || session.clock_out) return;

    if (type === 'lunch') {
      startSegment('lunch');
      return;
    }

    if (type === 'drive') {
      if (!driveTicket.ticket_id) {
        alert('No drive ticket set for this month. Tap the ⚙ icon to configure it.');
        return;
      }
      startSegment(
        'drive',
        driveTicket.ticket_id,
        driveTicket.ticket_num ?? '',
        driveTicket.ticket_name ?? '',
      );
      return;
    }

    // onsite — open picker
    setPickerMode('start');
    setShowTicketPicker(true);
  };

  // ── Ticket selected from picker ───────────────────────────────────────────
  const handleTicketSelect = (t: WorkTicket) => {
    setShowTicketPicker(false);
    startSegment(
      'onsite',
      t.WorkTicketID,
      String(t.WorkTicketNumber || t.WorkTicketID),
      t.OpportunityName || t.WorkTicketTitle || `#${t.WorkTicketID}`,
    );
  };

  const handleTicketManual = (id: string, num: string, name: string) => {
    setShowTicketPicker(false);
    startSegment('onsite', parseInt(id, 10), num, name);
  };

  // ── Clock out ─────────────────────────────────────────────────────────────
  const handleClockOut = async () => {
    if (!session) return;
    if (!window.confirm('Clock out now?')) return;
    setActionLoading(true);
    try {
      const r = await apiFetch<{ session: TimeSession; segments: TimeSegment[] }>(
        'POST', '/time/clock-out', { session_id: session.id }
      );
      setSession(r.session);
      setSegments(r.segments);
    } catch (e: unknown) {
      alert(`Clock-out failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActionLoading(false);
    }
  };

  // ── Submit to Aspire ──────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!session) return;
    if (!window.confirm('Submit this day to Aspire? This cannot be undone.')) return;
    setActionLoading(true);
    setSubmitError(null);
    setSubmitOk(false);
    try {
      await apiFetch('POST', `/time/submit/${session.id}`);
      setSubmitOk(true);
      // Refresh session
      const r = await apiFetch<{ session: TimeSession; segments: TimeSegment[] }>(
        'GET',
        `/time/session?employee_id=${session.employee_id}&work_date=${session.work_date}`
      );
      if (r.session) { setSession(r.session); setSegments(r.segments); }
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionLoading(false);
    }
  };

  // ── Save drive ticket ─────────────────────────────────────────────────────
  const handleSaveDriveTicket = async (dt: DriveTicket) => {
    if (!dt.ticket_id) return;
    try {
      await apiFetch('POST', '/time/drive-ticket', {
        ticket_id:   dt.ticket_id,
        ticket_num:  dt.ticket_num ?? '',
        ticket_name: dt.ticket_name ?? '',
        month:       dt.ticket_month ?? new Date().toISOString().slice(0, 7),
      });
      setDriveTicket(dt);
      setShowDriveSettings(false);
    } catch (e: unknown) {
      alert(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── Edit segment times ────────────────────────────────────────────────────
  const handleSaveSegmentTimes = async (
    segId: number,
    startHHMM: string,
    endHHMM: string,
  ) => {
    if (!session) return;
    const workDate = session.work_date;
    const allSegs  = segments.filter(s => s.id !== segId && s.end_time);

    // Overlap check: new interval must not overlap any other completed segment
    const toMs = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    };
    const newStart = toMs(startHHMM);
    const newEnd   = toMs(endHHMM);
    if (newEnd <= newStart) {
      alert('End time must be after start time.');
      return;
    }
    const isoToHHMM = (iso: string | null) => {
      if (!iso) return null;
      try { return new Date(iso).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false }); }
      catch { return null; }
    };
    for (const s of allSegs) {
      const sStart = isoToHHMM(s.start_time);
      const sEnd   = isoToHHMM(s.end_time);
      if (!sStart || !sEnd) continue;
      const sS = toMs(sStart), sE = toMs(sEnd);
      if (newStart < sE && newEnd > sS) {
        alert(`Time overlaps with another ${s.segment_type} segment (${sStart}–${sEnd}). Please adjust.`);
        return;
      }
    }
    try {
      const r = await apiFetch<{ segment: TimeSegment }>(
        'PATCH', `/time/segment/${segId}/times`,
        {
          start_time: localHHMMtoUTCIso(startHHMM, workDate),
          end_time:   localHHMMtoUTCIso(endHHMM,   workDate),
          work_date:  workDate,
        }
      );
      setSegments(prev => prev.map(s => s.id === segId ? r.segment : s));
      setEditSegment(null);
    } catch (e: unknown) {
      alert(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── Edit clock-in / clock-out ─────────────────────────────────────────────
  const handleSaveClockTime = async (field: 'in' | 'out', hhmm: string) => {
    if (!session) return;
    const workDate = session.work_date;
    const body = field === 'in'
      ? { clock_in: localHHMMtoUTCIso(hhmm, workDate), work_date: workDate }
      : { clock_out: localHHMMtoUTCIso(hhmm, workDate), work_date: workDate };

    // Basic sanity: clock-out must be after clock-in
    if (field === 'out' && session.clock_in) {
      const isoToHHMM = (iso: string) => new Date(iso).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false });
      const inHHMM  = isoToHHMM(session.clock_in);
      const toMs = (t: string) => { const [h,m] = t.split(':').map(Number); return h*60+m; };
      if (toMs(hhmm) <= toMs(inHHMM)) {
        alert('Clock-out must be after clock-in.');
        return;
      }
    }
    try {
      const r = await apiFetch<{ session: TimeSession }>(
        'PATCH', `/time/session/${session.id}/times`, body
      );
      setSession(r.session);
      setEditClockField(null);
    } catch (e: unknown) {
      alert(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── Sign out (clear localStorage) ────────────────────────────────────────
  const handleSignOut = () => {
    clearStoredSession();
    setPhase('pin');
    setPinInput('');
    setEmployee(null);
    setSession(null);
    setSegments([]);
    setRouteInfo(null);
    setRouteAutoDetected(false);
    setSubmitOk(false);
    setSubmitError(null);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER — PIN entry
  // ─────────────────────────────────────────────────────────────────────────

  if (phase === 'pin') {
    return (
      <div style={{
        minHeight: '100vh', background: '#0f172a',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', padding: 24,
      }}>
        <div style={{ marginBottom: 32, textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>⏱️</div>
          <h1 style={{ color: '#fff', fontSize: 24, fontWeight: 700, margin: 0 }}>Time Tracking</h1>
          <p style={{ color: '#64748b', fontSize: 14, marginTop: 6 }}>Enter your Aspire PIN</p>
        </div>

        {/* PIN text input */}
        <div style={{ width: '100%', maxWidth: 280, marginBottom: 16 }}>
          <input
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            placeholder="Your PIN"
            value={pinInput}
            onChange={e => setPinInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handlePin(); }}
            disabled={crewLoading}
            style={{
              width: '100%', padding: '16px', borderRadius: 12,
              background: '#1e293b', border: '2px solid #334155',
              color: '#fff', fontSize: 18, textAlign: 'center',
              outline: 'none', boxSizing: 'border-box',
              letterSpacing: 2,
            }}
          />
        </div>

        {pinError && (
          <div style={{
            background: '#fee2e2', color: '#dc2626', borderRadius: 10,
            padding: '10px 16px', marginBottom: 16, fontSize: 14, maxWidth: 280,
            textAlign: 'center',
          }}>
            {pinError}
          </div>
        )}

        <button
          onClick={handlePin}
          disabled={crewLoading || !pinInput.trim()}
          style={{
            width: '100%', maxWidth: 280, height: 56, borderRadius: 12,
            background: pinInput.trim() ? '#22c55e' : '#334155',
            border: 'none', color: '#fff', fontSize: 18, fontWeight: 700,
            cursor: pinInput.trim() ? 'pointer' : 'default',
            opacity: crewLoading ? 0.6 : 1,
          }}
        >
          {crewLoading ? 'Loading…' : 'Sign In'}
        </button>

        {crewLoading && (
          <div style={{ color: '#64748b', fontSize: 13, marginTop: 20 }}>Loading employee list…</div>
        )}
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER — Route selection screen
  // ─────────────────────────────────────────────────────────────────────────

  if (phase === 'route') {
    const confirmed = routeInfo !== null;
    return (
      <div style={{
        minHeight: '100vh', background: '#0f172a',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', padding: 24,
      }}>
        <div style={{ marginBottom: 28, textAlign: 'center' }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🗺️</div>
          <h1 style={{ color: '#fff', fontSize: 22, fontWeight: 700, margin: 0 }}>
            {employee?.FullName}
          </h1>
          <p style={{ color: '#64748b', fontSize: 13, marginTop: 4 }}>
            {fmtDate(today)}
          </p>
        </div>

        {routeLoading ? (
          <div style={{ color: '#64748b', fontSize: 15 }}>Looking up your route…</div>
        ) : routeAutoDetected && routeInfo ? (
          /* ── Auto-detected route ────────────────────────────────────── */
          <div style={{ width: '100%', maxWidth: 340 }}>
            <div style={{
              background: '#1e293b', borderRadius: 14, padding: 20, marginBottom: 16,
            }}>
              <div style={{ color: '#94a3b8', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                Your assigned route
              </div>
              <div style={{ color: '#22c55e', fontSize: 22, fontWeight: 700 }}>
                {routeInfo.route_name ?? 'Unknown Route'}
              </div>
              {routeInfo.crew_leader_name && (
                <div style={{ color: '#64748b', fontSize: 13, marginTop: 4 }}>
                  Crew Lead: {routeInfo.crew_leader_name}
                </div>
              )}
            </div>
            <button
              onClick={() => setPhase('main')}
              style={{
                width: '100%', padding: 18, borderRadius: 12, border: 'none',
                background: '#22c55e', color: '#fff', fontSize: 18, fontWeight: 700,
                cursor: 'pointer', marginBottom: 12,
              }}
            >
              ✓ Confirm Route
            </button>
            <button
              onClick={() => setRouteAutoDetected(false)}
              style={{
                width: '100%', padding: 14, borderRadius: 12,
                background: 'none', border: '1.5px solid #334155',
                color: '#94a3b8', fontSize: 15, cursor: 'pointer',
              }}
            >
              Choose a different route
            </button>
          </div>
        ) : (
          /* ── Manual route picker ────────────────────────────────────── */
          <div style={{ width: '100%', maxWidth: 340 }}>
            <div style={{ color: '#94a3b8', fontSize: 14, marginBottom: 12, textAlign: 'center' }}>
              {routeInfo ? 'Select your route:' : 'No route assigned — select your route:'}
            </div>
            <div style={{
              background: '#1e293b', borderRadius: 14, overflow: 'hidden',
              maxHeight: 320, overflowY: 'auto', marginBottom: 16,
            }}>
              {allRoutes.length === 0 ? (
                <div style={{ padding: 24, color: '#64748b', textAlign: 'center' }}>
                  No routes found
                </div>
              ) : allRoutes.map(r => (
                <button
                  key={r.RouteID}
                  onClick={() => setRouteInfo({
                    route_id:               r.RouteID,
                    route_name:             r.RouteName,
                    crew_leader_contact_id: r.CrewLeaderContactID,
                    crew_leader_name:       r.CrewLeaderContactName,
                  })}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '14px 20px', background: routeInfo?.route_id === r.RouteID ? '#0f3460' : 'none',
                    border: 'none', borderBottom: '1px solid #0f172a',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ color: routeInfo?.route_id === r.RouteID ? '#38bdf8' : '#e2e8f0', fontWeight: 600, fontSize: 16 }}>
                    {r.RouteName}
                  </div>
                  {r.CrewLeaderContactName && (
                    <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>
                      Lead: {r.CrewLeaderContactName}
                    </div>
                  )}
                </button>
              ))}
            </div>
            <button
              onClick={() => setPhase('main')}
              disabled={!confirmed}
              style={{
                width: '100%', padding: 18, borderRadius: 12, border: 'none',
                background: confirmed ? '#22c55e' : '#334155',
                color: '#fff', fontSize: 18, fontWeight: 700,
                cursor: confirmed ? 'pointer' : 'default', marginBottom: 12,
                opacity: confirmed ? 1 : 0.5,
              }}
            >
              {confirmed ? `✓ Continue — ${routeInfo!.route_name}` : 'Select a route to continue'}
            </button>
            <button
              onClick={() => setPhase('main')}
              style={{
                width: '100%', padding: 12, borderRadius: 12,
                background: 'none', border: 'none',
                color: '#475569', fontSize: 13, cursor: 'pointer',
              }}
            >
              Skip (no route)
            </button>
          </div>
        )}
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER — Main tracking screen
  // ─────────────────────────────────────────────────────────────────────────

  const isClockedIn  = !!session?.clock_in;
  const isClockedOut = !!session?.clock_out;
  const isSubmitted  = session?.status === 'submitted';

  const completedSegments = segments.filter(s => !!s.end_time);
  const totalMinutes = completedSegments.reduce((sum, s) => sum + (s.duration_minutes ?? 0), 0);

  const segBtnStyle = (type: 'onsite' | 'drive' | 'lunch', active: boolean) => {
    const colours: Record<string, { bg: string; border: string; text: string }> = {
      onsite: { bg: active ? '#16a34a' : '#f0fdf4', border: active ? '#16a34a' : '#86efac', text: active ? '#fff' : '#15803d' },
      drive:  { bg: active ? '#1d4ed8' : '#eff6ff', border: active ? '#1d4ed8' : '#93c5fd', text: active ? '#fff' : '#1d4ed8' },
      lunch:  { bg: active ? '#d97706' : '#fefce8', border: active ? '#d97706' : '#fcd34d', text: active ? '#fff' : '#92400e' },
    };
    const c = colours[type];
    return {
      flex: 1, minHeight: 72, borderRadius: 14,
      background: c.bg, border: `2px solid ${c.border}`, color: c.text,
      fontSize: 17, fontWeight: 700, cursor: 'pointer',
      display: 'flex', flexDirection: 'column' as const,
      alignItems: 'center', justifyContent: 'center', gap: 4,
      opacity: isClockedOut ? 0.4 : 1,
      transition: 'all 0.15s',
    };
  };

  return (
    <div style={{
      minHeight: '100vh', background: '#f1f5f9',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      maxWidth: 480, margin: '0 auto',
    }}>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div style={{
        background: '#0f172a', padding: '20px 20px 16px',
        position: 'sticky', top: 0, zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 20 }}>
              {employee?.FullName ?? 'Time Tracking'}
            </div>
            <div style={{ color: '#64748b', fontSize: 13, marginTop: 2 }}>
              {fmtDate(today)}
            </div>
            {routeInfo?.route_name && (
              <div style={{
                display: 'inline-block', marginTop: 4, padding: '2px 8px',
                background: '#0f3460', borderRadius: 6, color: '#38bdf8',
                fontSize: 12, fontWeight: 600,
              }}>
                🗺️ {routeInfo.route_name}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={() => setShowDriveSettings(true)}
              title="Drive ticket settings"
              style={{
                background: '#1e293b', border: 'none', color: '#94a3b8',
                borderRadius: 8, width: 36, height: 36, fontSize: 16,
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              ⚙
            </button>
            <button
              onClick={handleSignOut}
              title="Sign out"
              style={{
                background: '#1e293b', border: 'none', color: '#94a3b8',
                borderRadius: 8, padding: '8px 12px', fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Sign out
            </button>
          </div>
        </div>

        {/* Clock row */}
        {isClockedIn && (
          <div style={{
            display: 'flex', gap: 16, marginTop: 12,
            padding: '10px 14px', background: '#1e293b', borderRadius: 10,
            alignItems: 'center',
          }}>
            <button
              onClick={() => setEditClockField('in')}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#94a3b8', fontSize: 13 }}
            >
              In: <span style={{ color: '#22c55e', fontWeight: 600, textDecoration: 'underline dotted' }}>{fmtTime(session?.clock_in ?? null)}</span>
            </button>
            {isClockedOut && (
              <button
                onClick={() => setEditClockField('out')}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#94a3b8', fontSize: 13 }}
              >
                Out: <span style={{ color: '#f87171', fontWeight: 600, textDecoration: 'underline dotted' }}>{fmtTime(session?.clock_out ?? null)}</span>
              </button>
            )}
            <div style={{ color: '#94a3b8', fontSize: 13, marginLeft: 'auto' }}>
              Total: <span style={{ color: '#22c55e', fontWeight: 700 }}>{fmtDuration(totalMinutes)}</span>
            </div>
          </div>
        )}
      </div>

      <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── Loading spinner ────────────────────────────────────────────── */}
        {sessionLoading && (
          <div style={{
            background: '#fff', borderRadius: 14, padding: 32,
            textAlign: 'center', color: '#64748b',
          }}>
            Loading…
          </div>
        )}

        {/* ── Submitted banner ──────────────────────────────────────────── */}
        {isSubmitted && (
          <div style={{
            background: '#dcfce7', border: '2px solid #86efac',
            borderRadius: 14, padding: 20, textAlign: 'center',
          }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>✅</div>
            <div style={{ fontWeight: 700, color: '#15803d', fontSize: 17 }}>
              Submitted to Aspire
            </div>
            <div style={{ color: '#166534', fontSize: 13, marginTop: 4 }}>
              {fmtTime(session?.submitted_at ?? null)}
            </div>
          </div>
        )}

        {/* ── Clock In button ───────────────────────────────────────────── */}
        {!sessionLoading && !isClockedIn && !isSubmitted && (
          <button
            onClick={handleClockIn}
            disabled={actionLoading}
            style={{
              width: '100%', minHeight: 80, borderRadius: 16,
              background: '#22c55e', border: 'none', color: '#fff',
              fontSize: 22, fontWeight: 700, cursor: 'pointer',
              opacity: actionLoading ? 0.6 : 1,
            }}
          >
            {actionLoading ? 'Clocking in…' : '🕐 Clock In'}
          </button>
        )}

        {/* ── Active segment display ────────────────────────────────────── */}
        {isClockedIn && !isClockedOut && openSegment && (
          <div style={{
            background: '#fff', borderRadius: 14, padding: 20,
            border: '2px solid ' + (
              openSegment.segment_type === 'onsite' ? '#86efac' :
              openSegment.segment_type === 'drive'  ? '#93c5fd' : '#fcd34d'
            ),
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <span style={{
                  display: 'inline-block', padding: '3px 10px', borderRadius: 20,
                  fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
                  background: openSegment.segment_type === 'onsite' ? '#dcfce7' :
                              openSegment.segment_type === 'drive'  ? '#dbeafe' : '#fef9c3',
                  color:      openSegment.segment_type === 'onsite' ? '#15803d' :
                              openSegment.segment_type === 'drive'  ? '#1d4ed8' : '#92400e',
                }}>
                  {openSegment.segment_type === 'onsite' ? 'On-Site' :
                   openSegment.segment_type === 'drive'  ? 'Drive'   : 'Lunch'}
                </span>
                {openSegment.work_ticket_name && (
                  <div style={{ fontWeight: 600, fontSize: 15, marginTop: 6, color: '#0f172a' }}>
                    {openSegment.work_ticket_name}
                  </div>
                )}
                {(() => {
                  const t = tickets.find(t => t.WorkTicketID === openSegment.work_ticket_id);
                  return t ? (
                    <>
                      {t.PropertyName && (
                        <div style={{ fontSize: 13, color: '#475569', marginTop: 2, fontWeight: 500 }}>
                          {t.PropertyName}
                        </div>
                      )}
                      <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 3, display: 'flex', gap: 8 }}>
                        {openSegment.work_ticket_num && <span>#{openSegment.work_ticket_num}</span>}
                        {t.HoursEst != null && (
                          <span>· Est {fmtDuration(Math.round(t.HoursEst * 60))}</span>
                        )}
                      </div>
                    </>
                  ) : openSegment.work_ticket_num ? (
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                      #{openSegment.work_ticket_num}
                    </div>
                  ) : null;
                })()}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>
                  {elapsed}
                </div>
                <div style={{ fontSize: 12, color: '#64748b' }}>elapsed</div>
              </div>
            </div>

            {/* Switch ticket (onsite only) */}
            {openSegment.segment_type === 'onsite' && (
              <button
                onClick={() => { setPickerMode('switch'); setShowTicketPicker(true); }}
                style={{
                  marginTop: 12, width: '100%', padding: '10px',
                  background: '#f8fafc', border: '1px solid #e2e8f0',
                  borderRadius: 10, fontSize: 14, color: '#475569',
                  cursor: 'pointer', fontWeight: 600,
                }}
              >
                Switch Ticket
              </button>
            )}
          </div>
        )}

        {/* ── Segment buttons ───────────────────────────────────────────── */}
        {isClockedIn && !isClockedOut && !isSubmitted && (
          <div style={{ display: 'flex', gap: 10 }}>
            {(['onsite', 'drive', 'lunch'] as const).map(type => {
              const active = openSegment?.segment_type === type;
              const labels = { onsite: '🏗 On-Site', drive: '🚗 Drive', lunch: '🥪 Lunch' };
              return (
                <button
                  key={type}
                  onClick={() => handleSegmentButton(type)}
                  disabled={actionLoading || active}
                  style={segBtnStyle(type, active)}
                >
                  <span style={{ fontSize: 22 }}>
                    {type === 'onsite' ? '🏗' : type === 'drive' ? '🚗' : '🥪'}
                  </span>
                  <span>
                    {type === 'onsite' ? 'On-Site' : type === 'drive' ? 'Drive' : 'Lunch'}
                  </span>
                  {active && <span style={{ fontSize: 11, fontWeight: 400 }}>ACTIVE</span>}
                </button>
              );
            })}
          </div>
        )}

        {/* ── Clock Out ─────────────────────────────────────────────────── */}
        {isClockedIn && !isClockedOut && !isSubmitted && (
          <button
            onClick={handleClockOut}
            disabled={actionLoading}
            style={{
              width: '100%', minHeight: 64, borderRadius: 14,
              background: '#ef4444', border: 'none', color: '#fff',
              fontSize: 18, fontWeight: 700, cursor: 'pointer',
              opacity: actionLoading ? 0.6 : 1,
            }}
          >
            {actionLoading ? 'Clocking out…' : '🔴 Clock Out'}
          </button>
        )}

        {/* ── Clocked-out controls ──────────────────────────────────────── */}
        {isClockedOut && !isSubmitted && (
          <>
            {/* Clock back in */}
            <button
              onClick={handleClockIn}
              disabled={actionLoading}
              style={{
                width: '100%', minHeight: 56, borderRadius: 14,
                background: '#0f172a', border: '2px solid #22c55e', color: '#22c55e',
                fontSize: 16, fontWeight: 700, cursor: 'pointer',
                opacity: actionLoading ? 0.6 : 1,
              }}
            >
              🟢 Clock Back In
            </button>

            {submitError && (
              <div style={{
                background: '#fee2e2', borderRadius: 10, padding: '12px 16px',
                color: '#dc2626', fontSize: 14,
              }}>
                <strong>Submission error:</strong> {submitError}
              </div>
            )}
            {submitOk && (
              <div style={{
                background: '#dcfce7', borderRadius: 10, padding: '12px 16px',
                color: '#15803d', fontSize: 14, fontWeight: 600,
              }}>
                Successfully submitted to Aspire!
              </div>
            )}
            <button
              onClick={handleSubmit}
              disabled={actionLoading || submitOk}
              style={{
                width: '100%', minHeight: 70, borderRadius: 14,
                background: '#7c3aed', border: 'none', color: '#fff',
                fontSize: 18, fontWeight: 700, cursor: 'pointer',
                opacity: actionLoading || submitOk ? 0.6 : 1,
              }}
            >
              {actionLoading ? 'Submitting…' : '📤 Submit to Aspire'}
            </button>
          </>
        )}

        {/* ── Segment history ───────────────────────────────────────────── */}
        {completedSegments.length > 0 && (
          <div style={{ background: '#fff', borderRadius: 14, overflow: 'hidden' }}>
            <button
              onClick={() => setShowHistory(h => !h)}
              style={{
                width: '100%', padding: '14px 20px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: 'none', border: 'none', cursor: 'pointer',
                fontWeight: 700, fontSize: 15, color: '#0f172a',
              }}
            >
              <span>Segment History ({completedSegments.length})</span>
              <span style={{ color: '#64748b', fontSize: 18 }}>{showHistory ? '▲' : '▼'}</span>
            </button>
            {showHistory && (
              <div style={{ borderTop: '1px solid #f1f5f9' }}>
                {completedSegments.map(seg => (
                  <div key={seg.id} style={{
                    padding: '12px 20px', borderBottom: '1px solid #f1f5f9',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  }}>
                    <div style={{ flex: 1 }}>
                      <span style={{
                        display: 'inline-block', padding: '2px 8px', borderRadius: 12,
                        fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                        background: seg.segment_type === 'onsite' ? '#dcfce7' :
                                    seg.segment_type === 'drive'  ? '#dbeafe' : '#fef9c3',
                        color:      seg.segment_type === 'onsite' ? '#15803d' :
                                    seg.segment_type === 'drive'  ? '#1d4ed8' : '#92400e',
                        marginBottom: 4,
                      }}>
                        {seg.segment_type}
                      </span>
                      {seg.work_ticket_name && (
                        <div style={{ fontSize: 14, color: '#0f172a', fontWeight: 500 }}>
                          {seg.work_ticket_name}
                        </div>
                      )}
                      {(() => {
                        const t = tickets.find(t => t.WorkTicketID === seg.work_ticket_id);
                        return t?.PropertyName ? (
                          <div style={{ fontSize: 12, color: '#475569', marginTop: 1 }}>
                            {t.PropertyName}
                          </div>
                        ) : null;
                      })()}
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                        {fmtTime(seg.start_time)} – {fmtTime(seg.end_time)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ fontWeight: 700, fontSize: 15, color: '#0f172a', minWidth: 44, textAlign: 'right' }}>
                        {fmtDuration(seg.duration_minutes)}
                      </div>
                      <button
                        onClick={() => setEditSegment(seg)}
                        title="Edit times"
                        style={{
                          background: '#f1f5f9', border: 'none', borderRadius: 8,
                          padding: '6px 10px', cursor: 'pointer', fontSize: 16, color: '#475569',
                        }}
                      >✏️</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Edit segment times modal ─────────────────────────────────────── */}
      {editSegment && session && (() => {
        const toHHMM = (iso: string | null) => {
          if (!iso) return '';
          try { return new Date(iso).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false }); }
          catch { return ''; }
        };
        const initStart = toHHMM(editSegment.start_time);
        const initEnd   = toHHMM(editSegment.end_time);
        return (
          <EditTimesModal
            title={`Edit ${editSegment.segment_type} segment${editSegment.work_ticket_name ? ` — ${editSegment.work_ticket_name}` : ''}`}
            initStart={initStart}
            initEnd={initEnd}
            onSave={(s, e) => handleSaveSegmentTimes(editSegment.id, s, e)}
            onClose={() => setEditSegment(null)}
          />
        );
      })()}

      {/* ── Edit clock-in / clock-out modal ──────────────────────────────── */}
      {editClockField && session && (() => {
        const toHHMM = (iso: string | null) => {
          if (!iso) return '';
          try { return new Date(iso).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false }); }
          catch { return ''; }
        };
        const isOut  = editClockField === 'out';
        const initVal = toHHMM(isOut ? session.clock_out : session.clock_in);
        return (
          <EditSingleTimeModal
            title={isOut ? 'Edit Clock-Out Time' : 'Edit Clock-In Time'}
            initValue={initVal}
            onSave={(hhmm) => handleSaveClockTime(editClockField, hhmm)}
            onClose={() => setEditClockField(null)}
          />
        );
      })()}

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      {showTicketPicker && (
        <TicketPicker
          tickets={tickets}
          loading={ticketsLoading}
          routeName={routeInfo?.route_name}
          onSelect={handleTicketSelect}
          onManual={handleTicketManual}
          onClose={() => setShowTicketPicker(false)}
        />
      )}

      {showDriveSettings && (
        <DriveTicketSettings
          current={driveTicket}
          onSave={handleSaveDriveTicket}
          onClose={() => setShowDriveSettings(false)}
        />
      )}
    </div>
  );
}
