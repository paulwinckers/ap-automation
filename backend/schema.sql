-- AP Automation — Cloudflare D1 Schema
-- Run: npx wrangler d1 execute ap-automation-db --file=schema.sql

-- ── Vendor rules ────────────────────────────────────────────────────────────
-- The core routing config. One row per vendor.
-- type: 'job_cost' | 'overhead' | 'mixed'
CREATE TABLE IF NOT EXISTS vendor_rules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_name     TEXT NOT NULL,
    vendor_id_aspire TEXT,           -- Aspire ContactID if known
    vendor_id_qbo   TEXT,           -- QBO vendor ID if known
    type            TEXT NOT NULL CHECK(type IN ('job_cost','overhead','mixed')),
    default_gl_account TEXT,         -- QBO GL account code for OH vendors
    default_gl_name    TEXT,         -- Human-readable GL name
    forward_to      TEXT,            -- Email destination for job cost vendors
    notes           TEXT,
    is_employee     INTEGER NOT NULL DEFAULT 0,  -- 1 = appears in employee expense dropdown
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vendor_rules_name ON vendor_rules(vendor_name);
CREATE INDEX IF NOT EXISTS idx_vendor_rules_type ON vendor_rules(type);

-- ── Invoices ─────────────────────────────────────────────────────────────────
-- Every invoice that enters the system, regardless of status.
-- status: 'pending' | 'queued' | 'posted' | 'error'
-- destination: 'aspire' | 'qbo' | null (not yet determined)
CREATE TABLE IF NOT EXISTS invoices (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending','queued','posted','error')),
    destination         TEXT CHECK(destination IN ('aspire','qbo')),

    -- Raw extracted fields (from Claude)
    vendor_name         TEXT,
    vendor_id_resolved  INTEGER REFERENCES vendor_rules(id),
    invoice_number      TEXT,
    invoice_date        TEXT,
    due_date            TEXT,
    subtotal            REAL,
    tax_amount          REAL,
    total_amount        REAL,
    currency            TEXT DEFAULT 'CAD',
    po_number           TEXT,           -- as found on invoice
    po_number_override  TEXT,           -- manually entered by AP staff
    po_aspire_id        TEXT,           -- validated Aspire PO/Opportunity ID
    gl_account          TEXT,           -- resolved GL account for QBO
    gl_name             TEXT,           -- human-readable GL name

    -- File reference
    pdf_r2_key          TEXT,           -- R2 object key for the PDF
    pdf_filename        TEXT,

    -- Intake metadata
    intake_source       TEXT,           -- 'email' | 'upload' | 'api'
    intake_raw          TEXT,           -- JSON blob of original extraction

    -- Posting results
    aspire_receipt_id   TEXT,           -- returned by Aspire after posting
    qbo_bill_id         TEXT,           -- returned by QBO after posting
    error_message       TEXT,

    -- Timestamps
    received_at         TEXT NOT NULL DEFAULT (datetime('now')),
    queued_at           TEXT,
    reviewed_at         TEXT,
    posted_at           TEXT,
    reviewed_by         TEXT            -- Cloudflare Access user email
);

CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_vendor ON invoices(vendor_name);
CREATE INDEX IF NOT EXISTS idx_invoices_po ON invoices(po_number);

-- ── Invoice line items ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_line_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id      INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    description     TEXT,
    quantity        REAL,
    unit_price      REAL,
    amount          REAL,
    tax_code        TEXT,           -- GST / HST / PST
    tax_amount      REAL,
    sort_order      INTEGER DEFAULT 0
);

-- ── Audit log ────────────────────────────────────────────────────────────────
-- Immutable record of every action taken on every invoice.
CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id      INTEGER REFERENCES invoices(id),
    action          TEXT NOT NULL,  -- 'received' | 'extracted' | 'routed' |
                                    -- 'queued' | 'po_override' | 'posted' |
                                    -- 'error' | 'vendor_rule_added'
    actor           TEXT,           -- user email or 'system'
    detail          TEXT,           -- JSON with action-specific context
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_invoice ON audit_log(invoice_id);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_log(action);

-- ── PO cache ─────────────────────────────────────────────────────────────────
-- Short-lived cache of PO lookups from Aspire to reduce API calls.
-- TTL: 1 hour. Cleared by the backend on a schedule.
CREATE TABLE IF NOT EXISTS po_cache (
    po_number       TEXT PRIMARY KEY,
    aspire_data     TEXT NOT NULL,  -- JSON blob from Aspire
    fetched_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Seed: initial vendor rules ───────────────────────────────────────────────
-- Replace these with your real vendors before deploying.
-- type options: 'job_cost' | 'overhead' | 'mixed'
INSERT OR IGNORE INTO vendor_rules (vendor_name, type, default_gl_account, default_gl_name, notes)
VALUES
    ('Example Supply Co',    'job_cost', NULL,    NULL,               'Materials — always job cost'),
    ('Office Depot',         'overhead', '6200',  'Office Supplies',  'OH only'),
    ('Telus',                'overhead', '6400',  'Telephone',        'Phone/internet — OH'),
    ('Example Fuel Co',      'mixed',    '6500',  'Fuel & Oil',       'Job cost if PO present');

-- ── Settings (key-value store) ───────────────────────────────────────────────
-- Used to persist rotating secrets like QBO refresh tokens across redeployments.
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Schema migrations (run on every startup, safe to re-run) ─────────────────
-- These ALTER TABLE statements are applied by _ensure_schema() on every deploy.
-- They are no-ops if the column already exists.
ALTER TABLE invoices ADD COLUMN gl_name TEXT;
ALTER TABLE vendor_rules ADD COLUMN is_employee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vendor_rules ADD COLUMN forward_to TEXT;
ALTER TABLE vendor_rules ADD COLUMN default_gl_name TEXT;
ALTER TABLE vendor_rules ADD COLUMN match_keyword TEXT;
ALTER TABLE vendor_rules ADD COLUMN aspire_post INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN doc_type TEXT;
ALTER TABLE invoices ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN invoice_number_display TEXT;

-- ── Vendor Statement Reconciliation ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reconciliation_periods (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    period      TEXT NOT NULL UNIQUE,
    label       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
    closed_at   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vendor_statements (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    period_id           INTEGER NOT NULL REFERENCES reconciliation_periods(id),
    vendor_name         TEXT NOT NULL,
    statement_date      TEXT,
    closing_balance     REAL,
    currency            TEXT DEFAULT 'CAD',
    aging_current       REAL DEFAULT 0,
    aging_1_30          REAL DEFAULT 0,
    aging_31_60         REAL DEFAULT 0,
    aging_61_90         REAL DEFAULT 0,
    aging_over_90       REAL DEFAULT 0,
    pdf_filename        TEXT,
    intake_source       TEXT DEFAULT 'upload',
    qbo_snapshot        TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS statement_lines (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_id    INTEGER NOT NULL REFERENCES vendor_statements(id) ON DELETE CASCADE,
    line_date       TEXT,
    invoice_number  TEXT,
    raw_description TEXT,
    amount          REAL,
    running_balance REAL
);

CREATE INDEX IF NOT EXISTS idx_stmt_period ON vendor_statements(period_id);
CREATE INDEX IF NOT EXISTS idx_stmt_vendor ON vendor_statements(vendor_name);
CREATE INDEX IF NOT EXISTS idx_stmt_lines  ON statement_lines(statement_id);

-- Migration: track where job-cost invoices were forwarded
ALTER TABLE invoices ADD COLUMN forwarded_to TEXT;

-- Migration: actual amount confirmed by QBO on posting (vs extracted total_amount)
ALTER TABLE invoices ADD COLUMN qbo_amount REAL;

-- ── Crew Assignments — field crew scheduling per route per day ────────────────
CREATE TABLE IF NOT EXISTS crew_assignments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    work_date     TEXT NOT NULL,        -- YYYY-MM-DD
    route_name    TEXT NOT NULL,        -- Aspire route / crew leader name
    employee_id   INTEGER NOT NULL,     -- Aspire ContactID
    employee_name TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_crew_date       ON crew_assignments(work_date);

-- ── Users — simple login for office/admin staff ───────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('admin','staff')),
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_login    TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_crew_date_route ON crew_assignments(work_date, route_name);

-- ── Vendor QBO links — permanent mapping from statement vendor name → QBO vendor ──
-- Bypasses fuzzy name matching so the right QBO account is always used.
CREATE TABLE IF NOT EXISTS vendor_qbo_links (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_name  TEXT NOT NULL UNIQUE,   -- as extracted from the statement PDF (case-insensitive key)
    qbo_vendor_id   TEXT NOT NULL,
    qbo_vendor_name TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
