/**
 * UserAdmin — manage office/admin user accounts.
 * Admin-only page: create, edit, deactivate, reset password.
 */

import { useEffect, useState } from 'react';
import {
  listUsers, createUser, updateUser, resetUserPassword,
  UserRecord,
} from '../lib/api';

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
  const [adding,   setAdding]   = useState(false);
  const [addErr,   setAddErr]   = useState('');

  // Edit inline
  const [editId,   setEditId]   = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState<'staff' | 'admin'>('staff');
  const [saving,   setSaving]   = useState(false);

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
      await createUser({ email: newEmail.trim(), name: newName.trim(), password: newPass, role: newRole });
      setNewName(''); setNewEmail(''); setNewPass(''); setNewRole('staff');
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
      await updateUser(userId, { name: editName, role: editRole });
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
    setEditRole(user.role);
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
            editRole={editRole}
            saving={saving}
            resetId={resetId}
            resetPass={resetPass}
            resetting={resetting}
            resetErr={resetErr}
            onStartEdit={startEdit}
            onEditName={setEditName}
            onEditRole={setEditRole}
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
              editRole={editRole}
              saving={saving}
              resetId={resetId}
              resetPass={resetPass}
              resetting={resetting}
              resetErr={resetErr}
              onStartEdit={startEdit}
              onEditName={setEditName}
              onEditRole={setEditRole}
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
  editRole: 'staff' | 'admin';
  saving: boolean;
  resetId: number | null;
  resetPass: string;
  resetting: boolean;
  resetErr: string;
  onStartEdit: (u: UserRecord) => void;
  onEditName: (v: string) => void;
  onEditRole: (v: 'staff' | 'admin') => void;
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
  editId, editName, editRole, saving,
  resetId, resetPass, resetting, resetErr,
  onStartEdit, onEditName, onEditRole, onSaveEdit, onCancelEdit,
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
              {/* Name + email */}
              <div>
                <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 14 }}>{user.name}</div>
                <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>{user.email}</div>
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
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 12, marginBottom: 12 }}>
                  <label>
                    <div style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>Name</div>
                    <input style={INPUT} value={editName} onChange={e => onEditName(e.target.value)} />
                  </label>
                  <label>
                    <div style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>Role</div>
                    <select style={{ ...INPUT, cursor: 'pointer' }} value={editRole} onChange={e => onEditRole(e.target.value as 'staff' | 'admin')}>
                      <option value="staff">Staff</option>
                      <option value="admin">Admin</option>
                    </select>
                  </label>
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
