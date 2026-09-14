export function nowIso() {
  return new Date().toISOString();
}

export function clampText(text, max = 50) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return 'Без названия';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function extractTextAndEntities(message) {
  if (typeof message?.text === 'string') {
    return { text: message.text, entities: message.entities ?? [] };
  }
  if (typeof message?.caption === 'string') {
    return { text: message.caption, entities: message.caption_entities ?? [] };
  }
  return { text: '', entities: [] };
}

export function detectMedia(message) {
  if (Array.isArray(message?.photo) && message.photo.length) {
    const largest = message.photo[message.photo.length - 1];
    return { type: 'photo', fileId: largest.file_id };
  }
  if (message?.video?.file_id) return { type: 'video', fileId: message.video.file_id };
  if (message?.animation?.file_id) return { type: 'animation', fileId: message.animation.file_id };
  if (message?.document?.file_id) return { type: 'document', fileId: message.document.file_id };
  return { type: null, fileId: null };
}

export function contentFromMessage(message) {
  const { text, entities } = extractTextAndEntities(message);
  const media = detectMedia(message);
  return {
    text,
    entities,
    mediaType: media.type,
    mediaFileId: media.fileId,
  };
}

export function stripCustomEmojiEntities(entities = []) {
  return entities.filter((e) => e?.type !== 'custom_emoji');
}

export function findFirstCustomEmoji(text, entities = []) {
  const entity = entities.find((e) => e?.type === 'custom_emoji' && e?.custom_emoji_id);
  if (!entity || typeof text !== 'string') return null;

  // Telegram offset/length are UTF-16 code units; JS slice uses the same indexing model.
  const start = entity.offset;
  const end = entity.offset + entity.length;
  const fallback = text.slice(start, end);
  const label = `${text.slice(0, start)}${text.slice(end)}`.replace(/\s+/g, ' ').trim();

  return {
    id: entity.custom_emoji_id,
    fallback,
    label,
  };
}

export function isValidButtonUrl(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return /^(https?:\/\/|tg:\/\/)/i.test(v);
}

export function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Warsaw',
  }).format(d);
}

export function postStatusLabel(status) {
  return {
    draft: '📝 Черновик',
    ready: '✅ Готов',
    archive: '📦 Архив',
    published: '📢 Опубликован',
  }[status] ?? status;
}

export function mediaLabel(type) {
  return {
    photo: '🖼 Фото',
    video: '🎬 Видео',
    animation: '🎞 GIF/анимация',
    document: '📎 Документ',
  }[type] ?? '📝 Только текст';
}
