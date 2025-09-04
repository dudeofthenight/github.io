CREATE TABLE IF NOT EXISTS sightings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  name TEXT,
  email TEXT,
  suspicious_meter INTEGER NOT NULL,
  photos_json TEXT NOT NULL DEFAULT '[]',
  submitted_at INTEGER NOT NULL,
  approved_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','approved'))
);
CREATE INDEX IF NOT EXISTS idx_sightings_status ON sightings (status);
CREATE INDEX IF NOT EXISTS idx_sightings_approved ON sightings (approved_at DESC);
CREATE INDEX IF NOT EXISTS idx_sightings_submitted ON sightings (submitted_at DESC);
