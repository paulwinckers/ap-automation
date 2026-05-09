-- Project Check-in System tables
-- Run: npx wrangler d1 execute ap-automation-db --remote --file=backend/migrations/checkin_tables.sql

CREATE TABLE IF NOT EXISTS construction_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    aspire_name TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    display_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    opportunity_id INTEGER NOT NULL,
    opportunity_name TEXT,
    property_name TEXT,
    lead_name TEXT,
    lead_email TEXT,
    month TEXT NOT NULL,
    ai_tip TEXT,
    ticket_snapshot TEXT,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    responded_at TEXT
);

CREATE TABLE IF NOT EXISTS project_checkin_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checkin_id INTEGER NOT NULL,
    remaining_hours REAL,
    approach_notes TEXT NOT NULL,
    blockers TEXT,
    submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_checkins_token     ON project_checkins(token);
CREATE INDEX IF NOT EXISTS idx_checkins_opp_month ON project_checkins(opportunity_id, month);
