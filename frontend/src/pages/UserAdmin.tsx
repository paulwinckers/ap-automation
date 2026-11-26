/**
 * UserAdmin — manage office/admin user accounts.
 * Admin-only page: create, edit, deactivate, reset password.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listUsers, createUser, updateUser, resetUserPassword, linkAspireContacts,
  UserRecord, DivisionMembership, DIVISIONS, AREAS, Area, AspireLinkResult,
} from '../lib/api';

// New staff start with the same areas existing staff got by default (backend DEFAULT_STAFF_AREAS).
const DEFAULT_AREAS: Area[] = ['customers', 'operations'];

const CARD: React.CSSProperties = {
  background: '#1e293b', border: '1px solid #334155',
  borderRadius: 12, padding: 24, marginBottom: 24,
};

const INPUT: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: '#0f172a', border: '1px solid #334155',
  borderRadius: 8, padding: '9px 12px',
  color: '#fff', fontSize: 14, outline: 'none',
};

const BTN = (color: string, disabled = false): React.CSSProperties => ({
  background: disabled ? '#1e293b' : color,
  color: disabled ? '#475569' : '#fff',
  border: 'none', borderRadius: 8,
  padding: '7px 14px', fontSize: 13, fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
  whiteSpace: 'nowrap',
});

function RoleBadge({ role }: { role: string }) {
  return (
    <span style={{
      background: role === 'admin' ? '#1d4ed8' : '#065f46',
      color: '#fff', fontSize: 11, fontWeight: 700,
      padding: '2px 8px', borderRadius: 99, textTransform: 'uppercase',
    }}>{role}</span>
  );
}

// Multi-select divisions with a per-division "default notify" toggle.
function DivisionPicker({ value, onChange }: { value: DivisionMembership[]; onChange: (v: DivisionMembership[]) => void }) {
  const byDiv = new Map(value.map(d => [d.division, d]));
  const toggle = (division: string) => {
    const next = new Map(byDiv);
    if (next.has(division)) next.delete(division);
    else next.set(division, { division, is_default: false });
    onChange(Array.from(next.values()));
  };
  const toggleDefault = (division: string) => {
    const next = new Map(byDiv);
    const cur = next.get(division);
    if (cur) next.set(division, { ...cur, is_default: !cur.is_default });
    onChange(Array.from(next.values()));
  };
  return (
    <div>
      <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>DIVISIONS</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {DIVISIONS.map(div => {
          const member = byDiv.get(div);
          return (
            <div key={div} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minWidth: 200 }}>
                <input type="checkbox" checked={!!member} onChange={() => toggle(div)}
                  style={{ width: 16, height: 16, accentColor: '#2563eb', cursor: 'pointer' }} />
                <span style={{ color: member ? '#e2e8f0' : '#64748b', fontSize: 13 }}>{div}</span>
              </label>
              {member && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={member.is_default} onChange={() => toggleDefault(div)}
                    style={{ width: 14, height: 14, accentColor: '#16a34a', cursor: 'pointer' }} />
                  <span style={{ color: member.is_default ? '#4ade80' : '#64748b', fontSize: 11 }}>default notify</span>
                </label>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Access areas — what this person can see and do. Admins always have every area.
function AreaPicker({ value, onChange, isAdmin }: { value: Area[]; onChange: (v: Area[]) => void; isAdmin: boolean }) {
  const toggle = (a: Area) => onChange(value.includes(a) ? value.filter(x => x !== a) : [...value, a]);
  return (
    <div>
      <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>ACCESS</div>
      {isAdmin ? (
        <div style={{ color: '#64748b', fontSize: 13 }}>Admins have access to everything.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {AREAS.map(a => (
            <label key={a.key} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={value.includes(a.key)} onChange={() => toggle(a.key)}
                style={{ width: 16, height: 16, accentColor: '#2563eb', cursor: 'pointer' }} />
              <span style={{ color: value.includes(a.key) ? '#e2e8f0' : '#64748b', fontSize: 13, minWidth: 140 }}>{a.label}</span>
              <span style={{ color: '#475569', fontSize: 11 }}>{a.hint}</span>
            </label>
          ))}
          <button type="button" onClick={() => onChange(['training'])}
            style={{ alignSelf: 'flex-start', marginTop: 2, background: 'none', border: '1px solid #334155', color: '#94a3b8',
              borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer' }}>
            Crew lead: Training only
          </button>
        </div>
      )}
    </div>
  );
}

function AreaChips({ user }: { user: UserRecord }) {
  if (user.role === 'admin' || !user.areas) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
      {user.areas.length === 0
        ? <span style={{ color: '#f87171', fontSize: 10, fontWeight: 600 }}>No access areas</span>
        : AREAS.filter(a => user.areas!.includes(a.key)).map(a => (
          <span key={a.key} style={{ background: '#1e3a8a', color: '#bfdbfe', fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 99 }}>
            {a.label}
          </span>
        ))}
    </div>
  );
}

function DivisionChips({ divisions }: { divisions?: DivisionMembership[] }) {
  if (!divisions || divisions.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
      {divisions.map(d => (
        <span key={d.division} style={{
          background: d.is_default ? '#14532d' : '#334155', color: d.is_default ? '#bbf7d0' : '#cbd5e1',
          fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 99,
        }}>
          {d.division}{d.is_default ? ' ★' : ''}
        </span>
      ))}
    </div>
  );
}

// Email-match app users to Aspire employees so one identity resolves across app login,
// task assignee, CX role owner, and Aspire crew/clock-in. Preview (dry run) then link.
function AspireLinkCard({ onLinked }: { onLinked: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<AspireLinkResult | null>(null);
  const [done, setDone] = useState<AspireLinkResult | null>(null);
  const [err, setErr] = useState('');

  async function runPreview() {
    setBusy(true); setErr(''); setDone(null);
    try { setPreview(await linkAspireContacts(true)); setOpen(true); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  async function runLink() {
    setBusy(true); setErr('');
    try { const r = await linkAspireContacts(false); setDone(r); setPreview(null); onLinked(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  const c = (preview || done)?.counts;
  const list = (title: string, rows: { name: string; email: string }[], color: string) =>
    rows.length > 0 && (
      <div style={{ marginTop: 10 }}>
        <div style={{ color, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>{title} ({rows.length})</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {rows.map((r, i) => (
            <span key={i} title={r.email} style={{ background: '#0f172a', border: '1px solid #334155',
              color: '#cbd5e1', fontSize: 11, padding: '2px 8px', borderRadius: 99 }}>{r.name || r.email}</span>
          ))}
        </div>
      </div>
    );

  return (
    <div style={CARD}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ color: '#fff', fontWeight: 600, fontSize: 15 }}>Aspire identity links</div>
          <div style={{ color: '#64748b', fontSize: 12, marginTop: 3 }}>
            Match users to Aspire employees by email, so one person resolves across the app, tasks &amp; Aspire.
          </div>
        </div>
        <button onClick={runPreview} disabled={busy} style={BTN('#2563eb', busy)}>
          {busy ? 'Checking…' : 'Check matches'}
        </button>
      </div>

      {err && <div style={{ color: '#fca5a5', fontSize: 13, marginTop: 12 }}>{err}</div>}

      {done && (
        <div style={{ marginTop: 14, background: '#052e16', border: '1px solid #166534', borderRadius: 8, padding: '10px 14px' }}>
          <div style={{ color: '#86efac', fontSize: 13, fontWeight: 600 }}>
            ✓ Linked {done.counts.linked} user{done.counts.linked === 1 ? '' : 's'}
            {done.counts.already_linked > 0 ? ` · ${done.counts.already_linked} already linked` : ''}.
          </div>
          {list('App users with no Aspire email match', done.unmatched_users, '#fbbf24')}
        </div>
      )}

      {open && preview && (
        <div style={{ marginTop: 14, background: '#0f172a', border: '1px solid #334155', borderRadius: 10, padding: 16 }}>
          <div style={{ color: '#e2e8f0', fontSize: 13, marginBottom: 6 }}>
            {c!.linked > 0
              ? <>Ready to link <b>{c!.linked}</b> new match{c!.linked === 1 ? '' : 'es'}
                  {c!.already_linked > 0 ? ` (${c!.already_linked} already linked)` : ''}.</>
              : <>Everything already linked — {c!.already_linked} match{c!.already_linked === 1 ? '' : 'es'}, nothing new to do.</>}
          </div>
          {list('Will link now', preview.linked, '#86efac')}
          {list('App users with no Aspire email match', preview.unmatched_users, '#fbbf24')}
          {list('Aspire employees with no app user', preview.unmatched_employees, '#64748b')}
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            {c!.linked > 0 && (
              <button onClick={runLink} disabled={busy} style={BTN('#16a34a', busy)}>
                {busy ? 'Linking…' : `Link ${c!.linked} now`}
              </button>
            )}
            <button onClick={() => { setOpen(false); setPreview(null); }} style={BTN('#334155')}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function UserAdmin() {
  const [users,   setUsers]   = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  // Add-user form
  const [showAdd,  setShowAdd]  = useState(false);
  const [newName,  setNewName]  = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPass,  setNewPass]  = useState('');
  const [newRole,  setNewRole]  = useState<'staff' | 'admin'>('staff');
  const [newPhone, setNewPhone] = useState('');
  const [newDivisions, setNewDivisions] = useState<DivisionMembership[]>([]);
  const [newAreas, setNewAreas] = useState<Area[]>(DEFAULT_AREAS);
  const [adding,   setAdding]   = useState(false);
  const [addErr,   setAddErr]   = useState('');

  // Edit inline
  const [editId,    setEditId]    = useState<number | null>(null);
  const [editName,  setEditName]  = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole,  setEditRole]  = useState<'staff' | 'admin'>('staff');
  const [editPhone, setEditPhone] = useState('');
  const [editDivisions, setEditDivisions] = useState<DivisionMembership[]>([]);
  const [editAreas, setEditAreas] = useState<Area[]>([]);
  const [saving,    setSaving]    = useState(false);

  // Reset password
  const [resetId,   setResetId]   = useState<number | null>(null);
  const [resetPass, setResetPass] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetErr,  setResetErr]  = useState('');

  async function load() {
    try {
      setUsers(await listUsers());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (newPass.length < 8) { setAddErr('Password must be at least 8 characters.'); return; }
    setAddErr(''); setAdding(true);
    try {
      await createUser({ email: newEmail.trim(), name: newName.trim(), password: newPass, role: newRole, phone: newPhone.trim() || undefined, divisions: newDivisions, areas: newAreas });
      setNewName(''); setNewEmail(''); setNewPass(''); setNewRole('staff'); setNewPhone(''); setNewDivisions([]); setNewAreas(DEFAULT_AREAS);
      setShowAdd(false);
      await load();
    } catch (e) {
      setAddErr((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function handleSaveEdit(userId: number) {
    setSaving(true);
    try {
      await updateUser(userId, { name: editName, email: editEmail.trim(), role: editRole, phone: editPhone.trim() || null, divisions: editDivisions, areas: editAreas });
      setEditId(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(user: UserRecord) {
    const isActive = Boolean(user.active);
    try {
      await updateUser(user.id, { active: !isActive });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!resetId) return;
    if (resetPass.length < 8) { setResetErr('Password must be at least 8 characters.'); return; }
    setResetErr(''); setResetting(true);
    try {
      await resetUserPassword(resetId, resetPass);
      setResetId(null); setResetPass('');
    } catch (e) {
      setResetErr((e as Error).message);
    } finally {
      setResetting(false);
    }
  }

  function startEdit(user: UserRecord) {
    setEditId(user.id);
    setEditName(user.name);
    setEditEmail(user.email);
    setEditRole(user.role);
    setEditPhone(user.phone || '');
    setEditDivisions(user.divisions || []);
    setEditAreas(user.areas || DEFAULT_AREAS);
    setResetId(null);
  }

  const activeUsers   = users.filter(u => Boolean(u.active));
  const inactiveUsers = users.filter(u => !Boolean(u.active));

  return (
    <div style={{
      padding: 32, maxWidth: 860,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{ marginBottom: 28 }}>
        <div style={{ color: '#fff', fontWeight: 700, fontSize: 22 }}>User Management</div>
        <div style={{ color: '#64748b', fontSize: 13, marginTop: 4 }}>
          Office &amp; admin accounts — field staff don't need a login.
        </div>
      </div>

      {error && (
        <div style={{
          background: '#450a0a', border: '1px solid #991b1b',
          borderRadius: 8, padding: '10px 14px',
          color: '#fca5a5', fontSize: 13, marginBottom: 20,
        }}>{error}</div>
      )}

      {/* ── Aspire identity links ─────────────────────────────────────────────── */}
      <AspireLinkCard onLinked={load} />

      {/* ── Add user ──────────────────────────────────────────────────────────── */}
      <div style={CARD}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showAdd ? 20 : 0 }}>
          <div style={{ color: '#fff', fontWeight: 600, fontSize: 15 }}>Add user</div>
          <button
            onClick={() => { setShowAdd(s => !s); setAddErr(''); }}
            style={BTN(showAdd ? '#334155' : '#2563eb')}
          >
            {showAdd ? 'Cancel' : '+ Add user'}
          </button>
        </div>

        {showAdd && (
          <form onSubmit={handleAdd}>
            {addErr && (
              <div style={{
                background: '#450a0a', border: '1px solid #991b1b',
                borderRadius: 8, padding: '8px 12px',
                color: '#fca5a5', fontSize: 13, marginBottom: 14,
              }}>{addErr}</div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <label>
                <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>NAME</div>
                <input style={INPUT} value={newName} onChange={e => setNewName(e.target.value)} required placeholder="Jane Smith" />
              </label>
              <label>
                <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>EMAIL</div>
                <input style={INPUT} type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} required placeholder="jane@darios.ca" />
              </label>
              <label>
                <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>PHONE / WHATSAPP</div>
                <input style={INPUT} type="tel" value={newPhone} onChange={e => setNewPhone(e.target.value)} placeholder="604-555-1234" />
              </label>
              <label>
                <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>PASSWORD</div>
                <input style={INPUT} type="password" value={newPass} onChange={e => setNewPass(e.target.value)} required placeholder="Min 8 characters" />
              </label>
              <label>
                <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>ROLE</div>
                <select
                  style={{ ...INPUT, cursor: 'pointer' }}
                  value={newRole}
                  onChange={e => setNewRole(e.target.value as 'staff' | 'admin')}
                >
                  <option value="staff">Staff</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
            </div>
            <div style={{ marginBottom: 16 }}>
              <AreaPicker value={newAreas} onChange={setNewAreas} isAdmin={newRole === 'admin'} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <DivisionPicker value={newDivisions} onChange={setNewDivisions} />
            </div>
            <button type="submit" disabled={adding} style={BTN('#16a34a', adding)}>
              {adding ? 'Creating…' : 'Create user'}
            </button>
          </form>
        )}
      </div>

      {/* ── User list ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ color: '#64748b', textAlign: 'center', padding: 40 }}>Loading…</div>
      ) : (
        <>
          <UserTable
            users={activeUsers}
            title={`Active users (${activeUsers.length})`}
            editId={editId}
            editName={editName}
            editEmail={editEmail}
            onEditEmail={setEditEmail}
            editRole={editRole}
            editPhone={editPhone}
            editDivisions={editDivisions}
            onEditDivisions={setEditDivisions}
            editAreas={editAreas}
            onEditAreas={setEditAreas}
            saving={saving}
            resetId={resetId}
            resetPass={resetPass}
            resetting={resetting}
            resetErr={resetErr}
            onStartEdit={startEdit}
            onEditName={setEditName}
            onEditRole={setEditRole}
            onEditPhone={setEditPhone}
            onSaveEdit={handleSaveEdit}
            onCancelEdit={() => setEditId(null)}
            onToggleActive={handleToggleActive}
            onStartReset={u => { setResetId(u.id); setResetPass(''); setResetErr(''); setEditId(null); }}
            onResetPass={handleResetPassword}
            onResetPassChange={setResetPass}
            onCancelReset={() => setResetId(null)}
          />

          {inactiveUsers.length > 0 && (
            <UserTable
              users={inactiveUsers}
              title={`Deactivated (${inactiveUsers.length})`}
              dimmed
              editId={editId}
              editName={editName}
              editEmail={editEmail}
              onEditEmail={setEditEmail}
              editRole={editRole}
              editPhone={editPhone}
              editDivisions={editDivisions}
              onEditDivisions={setEditDivisions}
              editAreas={editAreas}
              onEditAreas={setEditAreas}
              saving={saving}
              resetId={resetId}
              resetPass={resetPass}
              resetting={resetting}
              resetErr={resetErr}
              onStartEdit={startEdit}
              onEditName={setEditName}
              onEditRole={setEditRole}
              onEditPhone={setEditPhone}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={() => setEditId(null)}
              onToggleActive={handleToggleActive}
              onStartReset={u => { setResetId(u.id); setResetPass(''); setResetErr(''); setEditId(null); }}
              onResetPass={handleResetPassword}
              onResetPassChange={setResetPass}
              onCancelReset={() => setResetId(null)}
            />
          )}
        </>
      )}

      <div style={{ color: '#64748b', fontSize: 12, marginTop: -8 }}>
        To change your own password, use <Link to="/account" style={{ color: '#93c5fd' }}>My account</Link>.
      </div>
    </div>
  );
}

// ── UserTable sub-component ───────────────────────────────────────────────────

interface UserTableProps {
  users: UserRecord[];
  title: string;
  dimmed?: boolean;
  editId: number | null;
  editName: string;
  editEmail: string;
  onEditEmail: (v: string) => void;
  editRole: 'staff' | 'admin';
  editPhone: string;
  editDivisions: DivisionMembership[];
  onEditDivisions: (v: DivisionMembership[]) => void;
  editAreas: Area[];
  onEditAreas: (v: Area[]) => void;
  saving: boolean;
  resetId: number | null;
  resetPass: string;
  resetting: boolean;
  resetErr: string;
  onStartEdit: (u: UserRecord) => void;
  onEditName: (v: string) => void;
  onEditRole: (v: 'staff' | 'admin') => void;
  onEditPhone: (v: string) => void;
  onSaveEdit: (id: number) => void;
  onCancelEdit: () => void;
  onToggleActive: (u: UserRecord) => void;
  onStartReset: (u: UserRecord) => void;
  onResetPass: (e: React.FormEvent) => void;
  onResetPassChange: (v: string) => void;
  onCancelReset: () => void;
}

function UserTable({
  users, title, dimmed = false,
  editId, editName, editEmail, onEditEmail, editRole, editPhone, editDivisions, onEditDivisions, editAreas, onEditAreas, saving,
  resetId, resetPass, resetting, resetErr,
  onStartEdit, onEditName, onEditRole, onEditPhone, onSaveEdit, onCancelEdit,
  onToggleActive, onStartReset, onResetPass, onResetPassChange, onCancelReset,
}: UserTableProps) {
  if (!users.length) return null;

  return (
    <div style={{ ...CARD, opacity: dimmed ? 0.7 : 1 }}>
      <div style={{ color: '#94a3b8', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 16 }}>
        {title}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {users.map((user, i) => (
          <div key={user.id}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 200px 90px auto',
              alignItems: 'center',
              gap: 12,
              padding: '12px 0',
              borderTop: i === 0 ? 'none' : '1px solid #1e293b',
            }}>
              {/* Name + email + phone */}
              <div>
                <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {user.name}
                  {user.aspire_contact_id
                    ? <span title={`Linked to Aspire ContactID ${user.aspire_contact_id}`}
                        style={{ background: '#1e3a8a', color: '#bfdbfe', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 99 }}>
                        Aspire #{user.aspire_contact_id}</span>
                    : <span title="Not matched to an Aspire employee — use “Check matches” above"
                        style={{ color: '#64748b', fontSize: 10, fontWeight: 600 }}>⚠ no Aspire link</span>}
                </div>
                <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>{user.email}</div>
                {user.phone && (
                  <div style={{ color: '#475569', fontSize: 12, marginTop: 1 }}>📱 {user.phone}</div>
                )}
                <AreaChips user={user} />
                <DivisionChips divisions={user.divisions} />
              </div>

              {/* Last login */}
              <div style={{ color: '#475569', fontSize: 12 }}>
                {user.last_login
                  ? `Last login ${new Date(user.last_login).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}`
                  : 'Never logged in'}
              </div>

              {/* Role */}
              <div><RoleBadge role={user.role} /></div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => onStartEdit(user)} style={BTN('#334155')}>Edit</button>
                <button onClick={() => onStartReset(user)} style={BTN('#334155')}>Password</button>
                <button
                  onClick={() => onToggleActive(user)}
                  style={BTN(Boolean(user.active) ? '#7f1d1d' : '#14532d')}
                >
                  {Boolean(user.active) ? 'Deactivate' : 'Reactivate'}
                </button>
              </div>
            </div>

            {/* Inline edit panel */}
            {editId === user.id && (
              <div style={{
                background: '#0f172a', border: '1px solid #334155',
                borderRadius: 10, padding: 16, marginBottom: 12,
              }}>
                <div style={{ color: '#94a3b8', fontSize: 12, fontWeight: 700, marginBottom: 12 }}>EDIT USER</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 160px', gap: 12, marginBottom: 12 }}>
                  <label>
                    <div style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>Name</div>
                    <input style={INPUT} value={editName} onChange={e => onEditName(e.target.value)} />
                  </label>
                  <label style={{ gridColumn: 'span 2' }}>
                    <div style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>Email (their login)</div>
                    <input style={INPUT} type="email" value={editEmail} onChange={e => onEditEmail(e.target.value)} />
                  </label>
                  <label>
                    <div style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>Phone / WhatsApp</div>
                    <input style={INPUT} type="tel" value={editPhone} onChange={e => onEditPhone(e.target.value)} placeholder="604-555-1234" />
                  </label>
                  <label>
                    <div style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>Role</div>
                    <select style={{ ...INPUT, cursor: 'pointer' }} value={editRole} onChange={e => onEditRole(e.target.value as 'staff' | 'admin')}>
                      <option value="staff">Staff</option>
                      <option value="admin">Admin</option>
                    </select>
                  </label>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <AreaPicker value={editAreas} onChange={onEditAreas} isAdmin={editRole === 'admin'} />
                </div>
                <div style={{ marginBottom: 14 }}>
                  <DivisionPicker value={editDivisions} onChange={onEditDivisions} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => onSaveEdit(user.id)} disabled={saving} style={BTN('#2563eb', saving)}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button onClick={onCancelEdit} style={BTN('#334155')}>Cancel</button>
                </div>
              </div>
            )}

            {/* Inline reset-password panel */}
            {resetId === user.id && (
              <form onSubmit={onResetPass} style={{
                background: '#0f172a', border: '1px solid #334155',
                borderRadius: 10, padding: 16, marginBottom: 12,
              }}>
                <div style={{ color: '#94a3b8', fontSize: 12, fontWeight: 700, marginBottom: 12 }}>RESET PASSWORD</div>
                {resetErr && (
                  <div style={{ color: '#fca5a5', fontSize: 12, marginBottom: 10 }}>{resetErr}</div>
                )}
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                  <label style={{ flex: 1 }}>
                    <div style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>New password (min 8 chars)</div>
                    <input
                      style={INPUT}
                      type="password"
                      value={resetPass}
                      onChange={e => onResetPassChange(e.target.value)}
                      required
                      placeholder="••••••••"
                    />
                  </label>
                  <button type="submit" disabled={resetting} style={BTN('#d97706', resetting)}>
                    {resetting ? 'Saving…' : 'Set password'}
                  </button>
                  <button type="button" onClick={onCancelReset} style={BTN('#334155')}>Cancel</button>
                </div>
              </form>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
