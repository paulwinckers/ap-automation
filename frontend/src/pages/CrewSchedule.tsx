/**
 * CrewSchedule.tsx — Daily crew assignment board.
 * Accessible at /ops/crew-schedule (office shell).
 *
 * Left panel: route columns pulled from Aspire for the selected date.
 *   Each route shows the crew leader (from Aspire) + any extra crew assigned
 *   here. Drag employee chips onto routes to assign them.
 *
 * Right panel: Staff Pool — unassigned employees for the day. Drag from here
 *   to a route. Drag a route assignment back here to unassign.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  getScheduledTickets,
  getCrewEmployees,
  getCrewAssignments,
  addCrewAssignment,
  removeCrewAssignment,
  type TicketRoute,
  type CrewEmployee,
  type CrewAssignment,
} from '../lib/api';

// ── helpers ───────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function rangeForDate(iso: string): 'today' | 'past' | 'upcoming' {
  const today = todayISO();
  if (iso === today) return 'today';
  if (iso < today)  return 'past';
  return 'upcoming';
}

// ── drag-and-drop payload ─────────────────────────────────────────────────────

interface DragPayload {
  employee_id:   number;
  employee_name: string;
  assignment_id?: number;   // set when dragging an existing assignment
  from_route?:   string;    // set when dragging from a route
}

const DND_KEY = 'application/crew-drag';

// ── styles ────────────────────────────────────────────────────────────────────

const S = {
  page: {
    padding: '24px 28px',
    maxWidth: 1400,
    margin: '0 auto',
    fontFamily: 'Inter, system-ui, sans-serif',
  } as React.CSSProperties,

  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 24,
    flexWrap: 'wrap' as const,
    gap: 12,
  },

  title: {
    fontSize: 22, fontWeight: 700, color: '#0f172a',
  },

  dateNav: {
    display: 'flex', alignItems: 'center', gap: 8,
  },

  navBtn: {
    background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8,
    padding: '6px 14px', cursor: 'pointer', fontSize: 14, color: '#374151',
    fontWeight: 600,
  },

  dateLabel: {
    fontSize: 15, fontWeight: 700, color: '#1e293b',
    minWidth: 150, textAlign: 'center' as const,
  },

  todayBtn: {
    background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8,
    padding: '6px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600,
  },

  board: {
    display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' as const,
  },

  // ── Pool ──────────────────────────────────────────────────────────────────

  poolSection: {
    background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12,
    padding: 16, marginBottom: 24,
  },

  poolTitle: {
    fontSize: 11, fontWeight: 700, color: '#6b7280',
    letterSpacing: '0.08em', textTransform: 'uppercase' as const,
    marginBottom: 12,
  },

  poolDrop: (over: boolean): React.CSSProperties => ({
    minHeight: 48, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start',
    borderRadius: 8, padding: 8,
    background: over ? '#dbeafe' : 'transparent',
    border: over ? '2px dashed #3b82f6' : '2px dashed transparent',
    transition: 'background 0.15s, border 0.15s',
  }),

  // ── Route card ────────────────────────────────────────────────────────────

  routeCard: (over: boolean): React.CSSProperties => ({
    background: '#fff', borderRadius: 12,
    border: over ? '2px solid #3b82f6' : '1px solid #e2e8f0',
    padding: 16, minWidth: 200, flex: '1 1 200px', maxWidth: 280,
    transition: 'border 0.15s, box-shadow 0.15s',
    boxShadow: over ? '0 0 0 4px #dbeafe' : '0 1px 3px rgba(0,0,0,0.05)',
  }),

  routeTitle: {
    fontSize: 13, fontWeight: 700, color: '#0f172a', marginBottom: 4,
  },

  routeSubtitle: {
    fontSize: 11, color: '#94a3b8', marginBottom: 12,
  },

  dropZone: (over: boolean): React.CSSProperties => ({
    minHeight: 40, borderRadius: 8, padding: '6px 8px',
    background: over ? '#eff6ff' : '#f8fafc',
    border: `1.5px dashed ${over ? '#3b82f6' : '#cbd5e1'}`,
    fontSize: 11, color: '#94a3b8', textAlign: 'center',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    marginTop: 8, transition: 'background 0.15s, border 0.15s',
  }),

  // ── Chips ─────────────────────────────────────────────────────────────────

  leadChip: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    background: '#1e40af', color: '#fff',
    borderRadius: 20, padding: '4px 10px', fontSize: 12, fontWeight: 600,
    marginBottom: 4, cursor: 'default', userSelect: 'none' as const,
  },

  assignedChip: (dragging: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 4,
    background: '#dcfce7', color: '#166534',
    borderRadius: 20, padding: '4px 10px', fontSize: 12, fontWeight: 600,
    marginBottom: 4, cursor: 'grab', userSelect: 'none' as const,
    opacity: dragging ? 0.5 : 1,
  }),

  poolChip: (dragging: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 4,
    background: '#f1f5f9', color: '#374151',
    borderRadius: 20, padding: '5px 12px', fontSize: 13, fontWeight: 500,
    cursor: 'grab', userSelect: 'none' as const,
    opacity: dragging ? 0.5 : 1,
    border: '1px solid #e2e8f0',
  }),

  removeBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    color: '#166534', fontSize: 14, lineHeight: 1, padding: 0,
    opacity: 0.7,
  },

  statusMsg: {
    fontSize: 13, color: '#6b7280', padding: '20px 0',
  },
} as const;

// ── Component ─────────────────────────────────────────────────────────────────

export default function CrewSchedule() {
  const [selectedDate, setSelectedDate] = useState(todayISO());
  const [routes, setRoutes]             = useState<TicketRoute[]>([]);
  const [employees, setEmployees]       = useState<CrewEmployee[]>([]);
  const [assignments, setAssignments]   = useState<Record<string, CrewAssignment[]>>({});
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);
  const [error, setError]               = useState<string | null>(null);

  // drag-over targets: 'pool' or route_name
  const [dragOver, setDragOver] = useState<string | null>(null);
  // which chip is being dragged (keyed by employee_id or assignment_id)
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // ── Load data when date changes ──────────────────────────────────────────
  useEffect(() => {
    setLoading(true); setError(null);
    const range = rangeForDate(selectedDate);
    Promise.all([
      getScheduledTickets(range, selectedDate),
      getCrewEmployees(),
      getCrewAssignments(selectedDate),
    ])
      .then(([routeRes, emps, assigns]) => {
        setRoutes(routeRes.routes);
        setEmployees(emps);
        setAssignments(assigns);
      })
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [selectedDate]);

  // ── Derive unassigned staff pool ─────────────────────────────────────────
  const allAssignedIds = new Set(
    Object.values(assignments).flat().map(a => a.employee_id)
  );
  const poolEmployees = employees.filter(e => !allAssignedIds.has(e.ContactID));

  // ── Drag handlers ────────────────────────────────────────────────────────

  function onDragStart(e: React.DragEvent, payload: DragPayload) {
    e.dataTransfer.setData(DND_KEY, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'move';
    setDraggingId(String(payload.assignment_id ?? payload.employee_id));
  }

  function onDragEnd() {
    setDraggingId(null);
    setDragOver(null);
  }

  function onDragOver(e: React.DragEvent, target: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(target);
  }

  const onDrop = useCallback(async (e: React.DragEvent, target: string) => {
    e.preventDefault();
    setDragOver(null);
    const raw = e.dataTransfer.getData(DND_KEY);
    if (!raw) return;
    const payload: DragPayload = JSON.parse(raw);

    // Dropping on the pool — remove from current route
    if (target === 'pool') {
      if (payload.assignment_id) {
        setSaving(true);
        await removeCrewAssignment(payload.assignment_id).catch(() => null);
        setAssignments(prev => {
          const next = { ...prev };
          for (const rn of Object.keys(next)) {
            next[rn] = next[rn].filter(a => a.id !== payload.assignment_id);
          }
          return next;
        });
        setSaving(false);
      }
      return;
    }

    // Dropping on a route
    const routeName = target;

    // If already on this route, do nothing
    if (payload.from_route === routeName) return;

    setSaving(true);

    // Remove from old route if dragging from a route
    if (payload.assignment_id && payload.from_route) {
      await removeCrewAssignment(payload.assignment_id).catch(() => null);
      setAssignments(prev => {
        const next = { ...prev };
        const oldRn = payload.from_route!;
        if (next[oldRn]) next[oldRn] = next[oldRn].filter(a => a.id !== payload.assignment_id);
        return next;
      });
    }

    // Add to new route
    const result = await addCrewAssignment(
      selectedDate, routeName, payload.employee_id, payload.employee_name
    ).catch(() => null);

    if (result) {
      const newAssignment: CrewAssignment = {
        id:            result.id,
        route_name:    routeName,
        employee_id:   payload.employee_id,
        employee_name: payload.employee_name,
      };
      setAssignments(prev => ({
        ...prev,
        [routeName]: [...(prev[routeName] ?? []), newAssignment],
      }));
    }
    setSaving(false);
  }, [selectedDate]);

  async function handleRemove(assignment: CrewAssignment) {
    setSaving(true);
    await removeCrewAssignment(assignment.id).catch(() => null);
    setAssignments(prev => {
      const next = { ...prev };
      next[assignment.route_name] = (next[assignment.route_name] ?? [])
        .filter(a => a.id !== assignment.id);
      return next;
    });
    setSaving(false);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={S.page}>
      {/* ── Header ── */}
      <div style={S.header}>
        <div style={S.title}>👥 Crew Schedule</div>
        <div style={S.dateNav}>
          <button style={S.navBtn} onClick={() => setSelectedDate(d => addDays(d, -1))}>←</button>
          <span style={S.dateLabel}>{fmtDate(selectedDate)}</span>
          <button style={S.navBtn} onClick={() => setSelectedDate(d => addDays(d, +1))}>→</button>
          {selectedDate !== todayISO() && (
            <button style={S.todayBtn} onClick={() => setSelectedDate(todayISO())}>Today</button>
          )}
          {saving && <span style={{fontSize:12, color:'#6b7280'}}>Saving…</span>}
        </div>
      </div>

      {loading && <div style={S.statusMsg}>Loading routes and staff…</div>}
      {error   && <div style={{...S.statusMsg, color:'#dc2626'}}>Error: {error}</div>}

      {!loading && !error && (
        <>
          {/* ── Staff Pool ── */}
          <div style={S.poolSection}>
            <div style={S.poolTitle}>Staff Pool — drag onto a route to assign</div>
            <div
              style={S.poolDrop(dragOver === 'pool')}
              onDragOver={e => onDragOver(e, 'pool')}
              onDragLeave={() => setDragOver(null)}
              onDrop={e => onDrop(e, 'pool')}
            >
              {poolEmployees.length === 0 && (
                <span style={{fontSize:12, color:'#9ca3af'}}>All staff assigned ✓</span>
              )}
              {poolEmployees.map(emp => (
                <div
                  key={emp.ContactID}
                  draggable
                  onDragStart={e => onDragStart(e, { employee_id: emp.ContactID, employee_name: emp.FullName })}
                  onDragEnd={onDragEnd}
                  style={S.poolChip(draggingId === String(emp.ContactID))}
                >
                  👤 {emp.FullName}
                </div>
              ))}
            </div>
          </div>

          {/* ── Route columns ── */}
          {routes.length === 0 && (
            <div style={S.statusMsg}>No routes scheduled for {fmtDate(selectedDate)}.</div>
          )}
          <div style={S.board}>
            {routes.map(route => {
              const routeAssignments = assignments[route.route_name] ?? [];
              const isOver = dragOver === route.route_name;
              return (
                <div
                  key={route.route_name}
                  style={S.routeCard(isOver)}
                  onDragOver={e => onDragOver(e, route.route_name)}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={e => onDrop(e, route.route_name)}
                >
                  {/* Route header */}
                  <div style={S.routeTitle}>🚛 {route.route_name}</div>
                  <div style={S.routeSubtitle}>
                    {route.ticket_count} ticket{route.ticket_count !== 1 ? 's' : ''}
                  </div>

                  {/* Crew leader (from Aspire — not draggable) */}
                  {route.crew_leader_name && (
                    <div style={S.leadChip} title="Crew leader (Aspire)">
                      ⭐ {route.crew_leader_name}
                    </div>
                  )}

                  {/* Extra assigned crew */}
                  <div style={{display:'flex', flexDirection:'column', gap:4, marginTop: route.crew_leader_name ? 6 : 0}}>
                    {routeAssignments.map(a => (
                      <div
                        key={a.id}
                        draggable
                        onDragStart={e => onDragStart(e, {
                          employee_id:   a.employee_id,
                          employee_name: a.employee_name,
                          assignment_id: a.id,
                          from_route:    route.route_name,
                        })}
                        onDragEnd={onDragEnd}
                        style={S.assignedChip(draggingId === String(a.id))}
                      >
                        {a.employee_name}
                        <button
                          style={S.removeBtn}
                          title="Remove"
                          onClick={() => handleRemove(a)}
                        >×</button>
                      </div>
                    ))}
                  </div>

                  {/* Drop hint */}
                  <div style={S.dropZone(isOver)}>
                    {isOver ? 'Drop to assign' : '+ drop crew here'}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
