-- Informational copy of the schema. The Worker creates these tables automatically.
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  text TEXT NOT NULL DEFAULT '',
  entities_json TEXT NOT NULL DEFAULT '[]',
  media_type TEXT,
  media_file_id TEXT,
  comments_enabled INTEGER NOT NULL DEFAULT 1,
  disable_notification INTEGER NOT NULL DEFAULT 0,
  link_preview_enabled INTEGER NOT NULL DEFAULT 1,
  published_chat_id TEXT,
  published_message_id INTEGER,
  discussion_chat_id TEXT,
  discussion_message_id INTEGER,
  comments_disabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);
CREATE TABLE IF NOT EXISTS buttons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  url TEXT NOT NULL,
  style TEXT,
  icon_custom_emoji_id TEXT,
  icon_fallback TEXT,
  FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  user_id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_buttons_post ON buttons(post_id, position, id);
CREATE INDEX IF NOT EXISTS idx_posts_published_lookup ON posts(published_chat_id, published_message_id);
