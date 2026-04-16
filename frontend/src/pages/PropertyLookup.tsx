/**
 * Property / Contact Lookup
 * Mobile-first search for field staff to find client phone numbers.
 * Route: /ops/contacts
 */

import React, { useState, useRef, useEffect } from 'react';
const API_BASE = import.meta.env.VITE_API_URL || 'https://ap-automation-production.up.railway.app';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Phone {
  label: string;
  number: string;
}

interface ContactResult {
  id: number;
  name: string;
  primary: boolean;
  billing: boolean;
  phones: Phone[];
  email: string | null;
}

interface PropertyResult {
  property_id: number;
  property_name: string;
  address?: string | null;
  contacts: ContactResult[];
}

interface LookupResponse {
  query: string;
  properties: PropertyResult[];
}

// ── Phone button ──────────────────────────────────────────────────────────────

function PhoneButton({ phone }: { phone: Phone }) {
  const clean = phone.number.replace(/\s+/g, '');
  return (
    <a
      href={`tel:${clean}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '8px 14px', borderRadius: 8,
        background: '#16a34a', color: '#fff',
        textDecoration: 'none', fontSize: 14, fontWeight: 600,
        boxShadow: '0 1px 4px rgba(22,163,74,0.3)',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontSize: 16 }}>📞</span>
      <span style={{ fontSize: 12, opacity: 0.85 }}>{phone.label}</span>
      <span>{phone.number}</span>
    </a>
  );
}

// ── Contact card ──────────────────────────────────────────────────────────────

function ContactCard({ contact }: { contact: ContactResult }) {
  const hasPhones = contact.phones.length > 0;
  return (
    <div style={{
      padding: '12px 16px',
      borderBottom: '1px solid #f1f5f9',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: hasPhones ? 10 : 0 }}>
        <span style={{ fontWeight: 600, fontSize: 14, color: '#111827', flex: 1 }}>
          {contact.name || '(unnamed)'}
        </span>
        {contact.primary && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
            background: '#dbeafe', color: '#1d4ed8',
          }}>Primary</span>
        )}
        {contact.billing && !contact.primary && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
            background: '#fef9c3', color: '#854d0e',
          }}>Billing</span>
        )}
      </div>

      {hasPhones && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {contact.phones.map((p, i) => <PhoneButton key={i} phone={p} />)}
        </div>
      )}

      {!hasPhones && (
        <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>No phone number on file</div>
      )}

      {contact.email && (
        <div style={{ marginTop: 6 }}>
          <a
            href={`mailto:${contact.email}`}
            style={{ fontSize: 12, color: '#2563eb', textDecoration: 'none' }}
          >
            ✉️ {contact.email}
          </a>
        </div>
      )}
    </div>
  );
}

// ── Property card ─────────────────────────────────────────────────────────────

function PropertyCard({ prop }: { prop: PropertyResult }) {
  const [expanded, setExpanded] = useState(false);
  const isProperty = prop.property_id !== null;
  const primaryContact = prop.contacts.find(c => c.primary);

  return (
    <div style={{
      background: '#fff',
      borderRadius: 12,
      boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
      border: '1px solid #e5e7eb',
      overflow: 'hidden',
      marginBottom: 12,
    }}>
      {/* Header */}
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '14px 16px', background: '#f8fafc',
          border: 'none', cursor: 'pointer', textAlign: 'left',
          borderBottom: expanded ? '1px solid #e5e7eb' : 'none',
        }}
      >
        <span style={{
          fontSize: 11, color: '#9ca3af',
          transform: expanded ? 'rotate(90deg)' : 'none',
          display: 'inline-block', transition: 'transform 0.15s', flexShrink: 0,
        }}>▶</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 15, color: '#111827' }}>
              {isProperty ? '🏠' : '👤'} {prop.property_name}
            </span>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999,
              background: isProperty ? '#dbeafe' : '#f3f4f6',
              color: isProperty ? '#1d4ed8' : '#6b7280',
              flexShrink: 0,
            }}>
              {isProperty ? 'Property' : 'Contact'}
            </span>
          </div>
          {prop.address && (
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>
              📍 {prop.address}
            </div>
          )}
          {primaryContact && primaryContact.phones.length > 0 && (
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              {primaryContact.name} · {primaryContact.phones[0].number}
            </div>
          )}
        </div>
        <span style={{
          fontSize: 11, color: '#9ca3af', flexShrink: 0,
        }}>
          {prop.contacts.length} contact{prop.contacts.length !== 1 ? 's' : ''}
        </span>
      </button>

      {/* Contacts */}
      {expanded && (
        <div>
          {prop.contacts.length === 0 ? (
            <div style={{ padding: '12px 16px', fontSize: 13, color: '#9ca3af', fontStyle: 'italic' }}>
              No contacts linked to this property.
            </div>
          ) : (
            prop.contacts.map(c => <ContactCard key={c.id} contact={c} />)
          )}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PropertyLookup() {
  const [query, setQuery]         = useState('');
  const [results, setResults]     = useState<LookupResponse | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const debounceRef               = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef                  = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleSearch(val: string) {
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (val.trim().length < 2) {
      setResults(null);
      setError(null);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const token = localStorage.getItem('ap_token');
        const res = await fetch(
          `${API_BASE}/aspire/field/contact-lookup?q=${encodeURIComponent(val.trim())}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        );
        if (!res.ok) throw new Error(`Search failed (${res.status})`);
        setResults(await res.json());
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    }, 400);
  }

  const totalProps    = results?.properties.length ?? 0;
  const totalContacts = results?.properties.reduce((s, p) => s + p.contacts.length, 0) ?? 0;

  return (
    <div style={{
      minHeight: '100vh',
      background: '#f1f5f9',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      {/* Header */}
      <div style={{
        background: '#0f172a',
        padding: '20px 20px 0',
        position: 'sticky', top: 0, zIndex: 10,
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
      }}>
        <h1 style={{ margin: '0 0 14px', fontSize: 18, fontWeight: 800, color: '#fff' }}>
          📞 Contact Lookup
        </h1>
        {/* Search bar */}
        <div style={{ position: 'relative', paddingBottom: 16 }}>
          <span style={{
            position: 'absolute', left: 14, top: '50%',
            transform: 'translateY(-60%)',
            fontSize: 16, color: '#94a3b8', pointerEvents: 'none',
          }}>🔍</span>
          <input
            ref={inputRef}
            type="search"
            placeholder="Search property or contact name…"
            value={query}
            onChange={e => handleSearch(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '12px 40px',
              borderRadius: 10, border: '2px solid #1e293b',
              fontSize: 16, background: '#1e293b', color: '#f8fafc',
              outline: 'none',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = '#22c55e')}
            onBlur={e  => (e.currentTarget.style.borderColor = '#1e293b')}
          />
          {query && (
            <button
              onClick={() => { setQuery(''); setResults(null); inputRef.current?.focus(); }}
              style={{
                position: 'absolute', right: 12, top: '50%', transform: 'translateY(-60%)',
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 18, color: '#64748b', lineHeight: 1,
              }}
            >✕</button>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '16px 16px 32px' }}>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: 'center', padding: 40, color: '#64748b' }}>
            <div style={{
              width: 28, height: 28, margin: '0 auto 12px',
              border: '3px solid #e2e8f0', borderTopColor: '#22c55e',
              borderRadius: '50%', animation: 'spin 0.7s linear infinite',
            }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            Searching Aspire…
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca',
            borderRadius: 10, padding: '14px 16px', color: '#dc2626',
            marginBottom: 16, fontSize: 14,
          }}>
            {error}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && query.length < 2 && (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: '#94a3b8' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>📋</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Find a client</div>
            <div style={{ fontSize: 14 }}>Type a property or contact name above</div>
          </div>
        )}

        {/* No results */}
        {!loading && !error && results && results.properties.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 20px', color: '#94a3b8' }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>🔍</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>No results for "{results.query}"</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Try a different name or property</div>
          </div>
        )}

        {/* Results */}
        {!loading && results && results.properties.length > 0 && (
          <>
            <div style={{
              fontSize: 12, color: '#64748b', marginBottom: 12, fontWeight: 600,
            }}>
              {totalProps} propert{totalProps !== 1 ? 'ies' : 'y'} · {totalContacts} contact{totalContacts !== 1 ? 's' : ''}
            </div>
            {results.properties.map(p => (
              <PropertyCard key={p.property_id} prop={p} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
