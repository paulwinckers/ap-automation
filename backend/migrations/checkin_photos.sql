-- Check-in photos: photos/videos taken by crew leads during daily check-in responses.
-- Files are stored in R2; this table links them to the check-in response.

CREATE TABLE IF NOT EXISTS checkin_photos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    checkin_id   INTEGER NOT NULL,   -- FK to project_checkins.id
    response_id  INTEGER,            -- FK to project_checkin_responses.id (set after save)
    file_name    TEXT    NOT NULL,
    file_extension TEXT,
    r2_key       TEXT    NOT NULL,
    file_size    INTEGER,
    uploaded_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_checkin_photos_checkin ON checkin_photos(checkin_id);
