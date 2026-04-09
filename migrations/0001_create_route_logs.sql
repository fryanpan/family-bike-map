CREATE TABLE IF NOT EXISTS route_logs (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  start_lat REAL NOT NULL,
  start_lng REAL NOT NULL,
  start_label TEXT,
  end_lat REAL NOT NULL,
  end_lng REAL NOT NULL,
  end_label TEXT,
  travel_mode TEXT NOT NULL,
  engine TEXT NOT NULL,
  distance_m REAL,
  duration_s REAL,
  preferred_pct REAL,
  lts_breakdown TEXT,
  worst_segment TEXT,
  route_coordinates TEXT
);

CREATE TABLE IF NOT EXISTS segment_feedback (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  route_log_id TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  osm_way_id INTEGER,
  feedback_type TEXT NOT NULL,
  comment TEXT,
  travel_mode TEXT
);

CREATE INDEX idx_route_logs_timestamp ON route_logs(timestamp);
CREATE INDEX idx_route_logs_engine ON route_logs(engine);
CREATE INDEX idx_segment_feedback_route ON segment_feedback(route_log_id);
