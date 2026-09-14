import { nowIso, safeJsonParse } from './utils.js';

let schemaReady = false;
let schemaPromise = null;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS posts (
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
  )`,
  `CREATE TABLE IF NOT EXISTS buttons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    url TEXT NOT NULL,
    style TEXT,
    icon_custom_emoji_id TEXT,
    icon_fallback TEXT,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    user_id TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_buttons_post ON buttons(post_id, position, id)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_published_lookup ON posts(published_chat_id, published_message_id)`,
];

export class Store {
  constructor(db) {
    this.db = db;
  }

  async ensureSchema() {
    if (schemaReady) return;
    if (!schemaPromise) {
      schemaPromise = this.db.batch(SCHEMA_STATEMENTS.map((sql) => this.db.prepare(sql)))
        .then(() => {
          schemaReady = true;
        })
        .catch((error) => {
          schemaPromise = null;
          throw error;
        });
    }
    await schemaPromise;
  }

  async first(sql, ...args) {
    return this.db.prepare(sql).bind(...args).first();
  }

  async all(sql, ...args) {
    const result = await this.db.prepare(sql).bind(...args).all();
    return result.results ?? [];
  }

  async run(sql, ...args) {
    return this.db.prepare(sql).bind(...args).run();
  }

  async getSetting(key, fallback = null) {
    const row = await this.first('SELECT value FROM settings WHERE key = ?', key);
    return row?.value ?? fallback;
  }

  async setSetting(key, value) {
    await this.run(`
      INSERT INTO settings(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, key, value == null ? null : String(value));
  }

  async getOwnerId() {
    const v = await this.getSetting('owner_user_id');
    return v ? Number(v) : null;
  }

  async setOwnerId(id) {
    await this.setSetting('owner_user_id', String(id));
  }

  async getIconPresets() {
    return safeJsonParse(await this.getSetting('icon_presets_json', '{}'), {});
  }

  async setIconPreset(key, preset) {
    const presets = await this.getIconPresets();
    presets[key] = preset;
    await this.setSetting('icon_presets_json', JSON.stringify(presets));
  }

  async clearIconPreset(key) {
    const presets = await this.getIconPresets();
    delete presets[key];
    await this.setSetting('icon_presets_json', JSON.stringify(presets));
  }

  async getSession(userId) {
    const row = await this.first('SELECT data_json FROM sessions WHERE user_id = ?', String(userId));
    return row ? safeJsonParse(row.data_json, null) : null;
  }

  async setSession(userId, data) {
    await this.run(`
      INSERT INTO sessions(user_id, data_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
    `, String(userId), JSON.stringify(data), nowIso());
  }

  async clearSession(userId) {
    await this.run('DELETE FROM sessions WHERE user_id = ?', String(userId));
  }

  async getChannelSettings() {
    const keys = [
      'channel_id', 'channel_title', 'channel_username',
      'discussion_group_id', 'discussion_group_title',
    ];
    const placeholders = keys.map(() => '?').join(',');
    const rows = await this.all(`SELECT key, value FROM settings WHERE key IN (${placeholders})`, ...keys);
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      id: map.channel_id || '',
      title: map.channel_title || '',
      username: map.channel_username || '',
      discussionGroupId: map.discussion_group_id || '',
      discussionGroupTitle: map.discussion_group_title || '',
    };
  }

  async setChannelSettings({ id, title, username, discussionGroupId, discussionGroupTitle }) {
    const now = [
      ['channel_id', id ?? ''],
      ['channel_title', title ?? ''],
      ['channel_username', username ?? ''],
      ['discussion_group_id', discussionGroupId ?? ''],
      ['discussion_group_title', discussionGroupTitle ?? ''],
    ];
    await this.db.batch(now.map(([key, value]) => this.db.prepare(`
      INSERT INTO settings(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).bind(key, String(value))));
  }

  async createPost(content) {
    const now = nowIso();
    const titleBase = content.text?.trim() || (content.mediaType ? `Новый ${content.mediaType}` : 'Новый пост');
    const title = titleBase.replace(/\s+/g, ' ').slice(0, 80);
    const result = await this.run(`
      INSERT INTO posts(
        title, status, text, entities_json, media_type, media_file_id,
        comments_enabled, disable_notification, link_preview_enabled,
        created_at, updated_at
      ) VALUES (?, 'draft', ?, ?, ?, ?, 1, 0, 1, ?, ?)
    `,
    title || 'Новый пост',
    content.text ?? '',
    JSON.stringify(content.entities ?? []),
    content.mediaType ?? null,
    content.mediaFileId ?? null,
    now,
    now);
    return Number(result.meta?.last_row_id);
  }

  async getPost(id) {
    const row = await this.first('SELECT * FROM posts WHERE id = ?', id);
    if (!row) return null;
    return {
      ...row,
      comments_enabled: Boolean(row.comments_enabled),
      disable_notification: Boolean(row.disable_notification),
      link_preview_enabled: Boolean(row.link_preview_enabled),
      entities: safeJsonParse(row.entities_json, []),
      buttons: await this.getButtons(id),
    };
  }

  async listPosts(status, limit = 8, offset = 0) {
    return this.all(`
      SELECT id, title, status, media_type, updated_at, published_at
      FROM posts
      WHERE status = ?
      ORDER BY CASE WHEN status = 'published' THEN COALESCE(published_at, updated_at) ELSE updated_at END DESC
      LIMIT ? OFFSET ?
    `, status, limit, offset);
  }

  async countPosts(status) {
    const row = await this.first('SELECT COUNT(*) AS c FROM posts WHERE status = ?', status);
    return Number(row?.c ?? 0);
  }

  async snapshot(postId, action) {
    const post = await this.getPost(postId);
    if (!post) return;
    await this.run(
      'INSERT INTO history(post_id, action, snapshot_json, created_at) VALUES (?, ?, ?, ?)',
      postId, action, JSON.stringify(post), nowIso(),
    );
  }

  async updatePostContent(postId, content, action = 'edit_content') {
    await this.snapshot(postId, action);
    await this.run(`
      UPDATE posts
      SET text = ?, entities_json = ?, media_type = ?, media_file_id = ?, updated_at = ?
      WHERE id = ?
    `,
    content.text ?? '',
    JSON.stringify(content.entities ?? []),
    content.mediaType ?? null,
    content.mediaFileId ?? null,
    nowIso(), postId);
  }

  async updatePostText(postId, text, entities, action = 'edit_text') {
    await this.snapshot(postId, action);
    await this.run(
      'UPDATE posts SET text = ?, entities_json = ?, updated_at = ? WHERE id = ?',
      text ?? '', JSON.stringify(entities ?? []), nowIso(), postId,
    );
  }

  async updatePostMedia(postId, mediaType, mediaFileId, text, entities, action = 'edit_media') {
    await this.snapshot(postId, action);
    await this.run(`
      UPDATE posts
      SET media_type = ?, media_file_id = ?, text = ?, entities_json = ?, updated_at = ?
      WHERE id = ?
    `, mediaType, mediaFileId, text ?? '', JSON.stringify(entities ?? []), nowIso(), postId);
  }

  async renamePost(postId, title) {
    await this.snapshot(postId, 'rename');
    await this.run('UPDATE posts SET title = ?, updated_at = ? WHERE id = ?', title, nowIso(), postId);
  }

  async setPostStatus(postId, status) {
    await this.snapshot(postId, `status:${status}`);
    await this.run('UPDATE posts SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), postId);
  }

  async setBool(postId, field, value) {
    const allowed = new Set(['comments_enabled', 'disable_notification', 'link_preview_enabled']);
    if (!allowed.has(field)) throw new Error('Unsupported boolean field');
    await this.snapshot(postId, `toggle:${field}`);
    await this.run(`UPDATE posts SET ${field} = ?, updated_at = ? WHERE id = ?`, value ? 1 : 0, nowIso(), postId);
  }

  async markPublished(postId, chatId, messageId) {
    await this.snapshot(postId, 'publish');
    const now = nowIso();
    await this.run(`
      UPDATE posts
      SET status = 'published', published_chat_id = ?, published_message_id = ?, published_at = ?, updated_at = ?
      WHERE id = ?
    `, String(chatId), messageId, now, now, postId);
  }

  async setDiscussionMessage(postId, discussionChatId, discussionMessageId) {
    await this.run(`
      UPDATE posts SET discussion_chat_id = ?, discussion_message_id = ?, updated_at = ? WHERE id = ?
    `, String(discussionChatId), discussionMessageId, nowIso(), postId);
  }

  async markCommentsDisabled(postId) {
    await this.run(`
      UPDATE posts SET comments_enabled = 0, comments_disabled_at = ?, updated_at = ? WHERE id = ?
    `, nowIso(), nowIso(), postId);
  }

  async findPublishedPost(chatId, messageId) {
    const row = await this.first(`
      SELECT id FROM posts WHERE published_chat_id = ? AND published_message_id = ? LIMIT 1
    `, String(chatId), messageId);
    return row ? this.getPost(row.id) : null;
  }

  async deletePost(postId) {
    await this.snapshot(postId, 'delete');
    await this.run('DELETE FROM posts WHERE id = ?', postId);
  }

  async getButtons(postId) {
    return this.all(`
      SELECT * FROM buttons WHERE post_id = ? ORDER BY position ASC, id ASC
    `, postId);
  }

  async addButton(postId, button) {
    await this.snapshot(postId, 'add_button');
    const row = await this.first('SELECT COALESCE(MAX(position), -1) AS m FROM buttons WHERE post_id = ?', postId);
    const result = await this.run(`
      INSERT INTO buttons(post_id, position, text, url, style, icon_custom_emoji_id, icon_fallback)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    postId,
    Number(row?.m ?? -1) + 1,
    button.text,
    button.url,
    button.style ?? null,
    button.iconCustomEmojiId ?? null,
    button.iconFallback ?? null);
    await this.run('UPDATE posts SET updated_at = ? WHERE id = ?', nowIso(), postId);
    return Number(result.meta?.last_row_id);
  }

  async getButton(id) {
    return (await this.first('SELECT * FROM buttons WHERE id = ?', id)) ?? null;
  }

  async updateButton(id, patch) {
    const current = await this.getButton(id);
    if (!current) return null;
    await this.snapshot(current.post_id, 'edit_button');
    const next = { ...current, ...patch };
    await this.run(`
      UPDATE buttons
      SET text = ?, url = ?, style = ?, icon_custom_emoji_id = ?, icon_fallback = ?
      WHERE id = ?
    `,
    next.text,
    next.url,
    next.style ?? null,
    next.icon_custom_emoji_id ?? null,
    next.icon_fallback ?? null,
    id);
    await this.run('UPDATE posts SET updated_at = ? WHERE id = ?', nowIso(), current.post_id);
    return this.getButton(id);
  }

  async deleteButton(id) {
    const current = await this.getButton(id);
    if (!current) return null;
    await this.snapshot(current.post_id, 'delete_button');
    await this.run('DELETE FROM buttons WHERE id = ?', id);
    await this.run('UPDATE posts SET updated_at = ? WHERE id = ?', nowIso(), current.post_id);
    return current;
  }
}

export { SCHEMA_STATEMENTS };
