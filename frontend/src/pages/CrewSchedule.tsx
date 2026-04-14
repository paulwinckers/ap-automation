/**
 * CrewSchedule.tsx — Daily crew assignment board.
 * Left panel:  route cards (from Aspire) with assigned crew.
 * Right panel: staff pool — drag names onto routes to assign.
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
  return d.toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' });
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

// ── drag payload ──────────────────────────────────────────────────────────────

interface DragPayload {
  employee_id:   number;
  employee_name: string;
  assignment_id?: number;
  from_route?:   string;
}

const DND_KEY = 'application/crew-drag';

// ── component ─────────────────────────────────────────────────────────────────

export default function CrewSchedule() {
  const [selectedDate, setSelectedDate] = useState(todayISO());
  const [routes,       setRoutes]       = useState<TicketRoute[]>([]);
  const [employees,    setEmployees]    = useState<CrewEmployee[]>([]);
  const [assignments,  setAssignments]  = useState<Record<string, CrewAssignment[]>>({});
  const [loading,      setLoading]      = useState(true);
  const [saving,       setSaving]       = useState(false);
  const [error,        setError]        = useState<string | null>(null);

  const [dragOver,   setDragOver]   = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // ── load ──────────────────────────────────────────────────────────────────
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

  // ── pool (unassigned employees) ───────────────────────────────────────────
  const allAssignedIds = new Set(
    Object.values(assignments).flat().map(a => a.employee_id)
  );
  const poolEmployees = employees.filter(e => !allAssignedIds.has(e.ContactID));

  // ── drag handlers ─────────────────────────────────────────────────────────

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

    if (target === 'pool') {
      if (payload.assignment_id) {
        setSaving(true);
        await removeCrewAssignment(payload.assignment_id).catch(() => null);
        setAssignments(prev => {
          const next = { ...prev };
          for (const rn of Object.keys(next))
            next[rn] = next[rn].filter(a => a.id !== payload.assignment_id);
          return next;
        });
        setSaving(false);
      }
      return;
    }

    const routeName = target;
    if (payload.from_route === routeName) return;

    setSaving(true);

    if (payload.assignment_id && payload.from_route) {
      await removeCrewAssignment(payload.assignment_id).catch(() => null);
      setAssignments(prev => {
        const next = { ...prev };
        const old = payload.from_route!;
        if (next[old]) next[old] = next[old].filter(a => a.id !== payload.assignment_id);
        return next;
      });
    }

    const result = await addCrewAssignment(
      selectedDate, routeName, payload.employee_id, payload.employee_name
    ).catch(() => null);

    if (result) {
      setAssignments(prev => ({
        ...prev,
        [routeName]: [...(prev[routeName] ?? []), {
          id: result.id,
          route_name: routeName,
          employee_id: payload.employee_id,
          employee_name: payload.employee_name,
        }],
      }));
    }
    setSaving(false);
  }, [selectedDate]);

  async function handleRemove(a: CrewAssignment) {
    setSaving(true);
    await removeCrewAssignment(a.id).catch(() => null);
    setAssignments(prev => {
      const next = { ...prev };
      next[a.route_name] = (next[a.route_name] ?? []).filter(x => x.id !== a.id);
      return next;
    });
    setSaving(false);
  }

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      fontFamily: 'Inter, system-ui, sans-serif', background: '#f8fafc',
    }}>

      {/* ── Top bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 24px', background: '#fff',
        borderBottom: '1px solid #e2e8f0', flexShrink: 0,
        flexWrap: 'wrap', gap: 12,
      }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a' }}>
          Crew Schedule
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setSelectedDate(d => addDays(d, -1))}
            style={navBtn}
          >←</button>
          <span style={{
            fontSize: 15, fontWeight: 700, color: '#1e293b',
            minWidth: 180, textAlign: 'center',
          }}>
            {fmtDate(selectedDate)}
          </span>
          <button
            onClick={() => setSelectedDate(d => addDays(d, +1))}
            style={navBtn}
          >→</button>
          {selectedDate !== todayISO() && (
            <button
              onClick={() => setSelectedDate(todayISO())}
              style={{ ...navBtn, background: '#3b82f6', color: '#fff', border: 'none' }}
            >Today</button>
          )}
          {saving && <span style={{ fontSize: 12, color: '#6b7280' }}>Saving…</span>}
        </div>
      </div>

      {/* ── Body: routes left, pool right ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Routes panel */}
        <div style={{
          flex: 1, overflowY: 'auto', padding: 24,
        }}>
          {loading && <p style={statusTxt}>Loading routes…</p>}
          {error   && <p style={{ ...statusTxt, color: '#dc2626' }}>Error: {error}</p>}
          {!loading && !error && routes.length === 0 && (
            <p style={statusTxt}>No routes scheduled for {fmtDate(selectedDate)}.</p>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {routes.map(route => {
              const routeAssignments = assignments[route.route_name] ?? [];
              const isOver = dragOver === route.route_name;
              return (
                <div
                  key={route.route_name}
                  style={{
                    background: '#fff',
                    border: isOver ? '2px solid #3b82f6' : '1px solid #e2e8f0',
                    borderRadius: 8,
                    padding: '8px 12px',
                    boxShadow: isOver
                      ? '0 0 0 3px #dbeafe'
                      : '0 1px 2px rgba(0,0,0,0.05)',
                    transition: 'border 0.15s, box-shadow 0.15s',
                  }}
                  onDragOver={e => onDragOver(e, route.route_name)}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={e => onDrop(e, route.route_name)}
                >
                  {/* Route header row */}
                  <div style={{
                    display: 'flex', alignItems: 'center',
                    justifyContent: 'space-between', marginBottom: 6,
                  }}>
                    <div>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>
                        {route.route_name}
                      </span>
                      <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 6 }}>
                        {route.ticket_count} ticket{route.ticket_count !== 1 ? 's' : ''}
                      </span>
                    </div>
                    {isOver && (
                      <span style={{ fontSize: 11, color: '#3b82f6', fontWeight: 600 }}>
                        Drop here
                      </span>
                    )}
                  </div>

                  {/* Crew chips */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minHeight: 24 }}>
                    {route.crew_leader_name && (
                      <span style={leadChip} title="Crew leader (Aspire)">
                        ⭐ {route.crew_leader_name}
                      </span>
                    )}

                    {routeAssignments.map(a => (
                      <span
                        key={a.id}
                        draggable
                        onDragStart={e => onDragStart(e, {
                          employee_id:   a.employee_id,
                          employee_name: a.employee_name,
                          assignment_id: a.id,
                          from_route:    route.route_name,
                        })}
                        onDragEnd={onDragEnd}
                        style={{
                          ...assignedChip,
                          opacity: draggingId === String(a.id) ? 0.4 : 1,
                        }}
                      >
                        {a.employee_name}
                        <button
                          style={removeBtn}
                          title="Remove"
                          onClick={() => handleRemove(a)}
                        >×</button>
                      </span>
                    ))}

                    {!route.crew_leader_name && routeAssignments.length === 0 && (
                      <span style={{ fontSize: 11, color: '#cbd5e1', alignSelf: 'center' }}>
                        Drop staff here
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Staff pool panel */}
        <div style={{
          width: 260, flexShrink: 0,
          borderLeft: '1px solid #e2e8f0',
          background: '#fff',
          display: 'flex', flexDirection: 'column',
          overflowY: 'auto',
        }}>
          <div style={{
            padding: '16px 16px 10px',
            borderBottom: '1px solid #f1f5f9',
            fontSize: 11, fontWeight: 700, color: '#6b7280',
            letterSpacing: '0.08em', textTransform: 'uppercase',
            flexShrink: 0,
          }}>
            Staff Pool
            <span style={{
              marginLeft: 8, fontSize: 11,
              color: poolEmployees.length === 0 ? '#22c55e' : '#6b7280',
              fontWeight: 400, textTransform: 'none', letterSpacing: 0,
            }}>
              {poolEmployees.length === 0 ? '— all assigned ✓' : `— ${poolEmployees.length} unassigned`}
            </span>
          </div>

          {/* Drop zone */}
          <div
            style={{
              flex: 1,
              padding: 12,
              background: dragOver === 'pool' ? '#eff6ff' : 'transparent',
              border: dragOver === 'pool' ? '2px dashed #3b82f6' : '2px dashed transparent',
              margin: 8, borderRadius: 10,
              transition: 'background 0.15s, border 0.15s',
            }}
            onDragOver={e => onDragOver(e, 'pool')}
            onDragLeave={() => setDragOver(null)}
            onDrop={e => onDrop(e, 'pool')}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {poolEmployees.map(emp => (
                <div
                  key={emp.ContactID}
                  draggable
                  onDragStart={e => onDragStart(e, {
                    employee_id:   emp.ContactID,
                    employee_name: emp.FullName,
                  })}
                  onDragEnd={onDragEnd}
                  style={{
                    ...poolChip,
                    opacity: draggingId === String(emp.ContactID) ? 0.4 : 1,
                  }}
                >
                  <span style={{ fontSize: 13, marginRight: 4 }}>👤</span>
                  {emp.FullName}
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

// ── static styles ─────────────────────────────────────────────────────────────

const navBtn: React.CSSProperties = {
  background: '#f1f5f9', border: '1px solid #e2e8f0',
  borderRadius: 8, padding: '6px 14px',
  cursor: 'pointer', fontSize: 14, color: '#374151', fontWeight: 600,
};

const statusTxt: React.CSSProperties = {
  fontSize: 13, color: '#6b7280', padding: '20px 0',
};

const leadChip: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 3,
  background: '#1e40af', color: '#fff',
  borderRadius: 20, padding: '2px 8px',
  fontSize: 11, fontWeight: 600,
  userSelect: 'none',
};

const assignedChip: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 3,
  background: '#dcfce7', color: '#166534',
  borderRadius: 20, padding: '2px 8px',
  fontSize: 11, fontWeight: 600,
  cursor: 'grab', userSelect: 'none',
};

const poolChip: React.CSSProperties = {
  display: 'flex', alignItems: 'center',
  background: '#f8fafc', border: '1px solid #e2e8f0',
  borderRadius: 8, padding: '8px 12px',
  fontSize: 13, fontWeight: 500, color: '#374151',
  cursor: 'grab', userSelect: 'none',
};

const removeBtn: React.CSSProperties = {
  background: 'none', border: 'none',
  cursor: 'pointer', color: '#166534',
  fontSize: 15, lineHeight: 1, padding: 0, opacity: 0.7,
};
