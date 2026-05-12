-- Job attachments: documents/photos stored in R2 and linked to Aspire opportunities.
-- Files bypass Aspire's API (which has no download endpoint).

CREATE TABLE IF NOT EXISTS job_attachments (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    opp_id           INTEGER NOT NULL,
    work_ticket_id   INTEGER,
    attachment_type  TEXT    NOT NULL DEFAULT 'General',
    file_name        TEXT    NOT NULL,
    file_extension   TEXT,
    r2_key           TEXT    NOT NULL,
    file_size        INTEGER,
    note             TEXT,
    uploaded_by      TEXT,
    uploaded_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    is_active        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_job_att_opp    ON job_attachments(opp_id);
CREATE INDEX IF NOT EXISTS idx_job_att_ticket ON job_attachments(work_ticket_id);
