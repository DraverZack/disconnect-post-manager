import { Store } from './db.js';
import { TelegramApi, TelegramApiError } from './telegram.js';
import {
  clampText,
  contentFromMessage,
  findFirstCustomEmoji,
  formatDateTime,
  isValidButtonUrl,
  mediaLabel,
  postStatusLabel,
} from './utils.js';

const kb = (...rows) => ({ inline_keyboard: rows });
const btn = (text, callback_data) => ({ text, callback_data });

async function ownerOnly(store, userId) {
  const ownerId = await store.getOwnerId();
  return ownerId != null && Number(userId) === Number(ownerId);
}

async function buildPublicMarkup(store, postId, { customIcons = true } = {}) {
  const buttons = await store.getButtons(postId);
  if (!buttons.length) return undefined;

  const rows = buttons.map((b) => {
    const base = {
      text: b.text,
      url: b.url,
      ...(b.style ? { style: b.style } : {}),
    };
    if (customIcons && b.icon_custom_emoji_id) {
      base.icon_custom_emoji_id = b.icon_custom_emoji_id;
    } else if (!customIcons && b.icon_custom_emoji_id) {
      base.text = `${b.icon_fallback || '🔗'} ${b.text}`.trim();
    }
    return [base];
  });

  const primary = { inline_keyboard: rows };
  const fallback = {
    inline_keyboard: buttons.map((b) => [{
      text: b.icon_custom_emoji_id ? `${b.icon_fallback || '🔗'} ${b.text}`.trim() : b.text,
      url: b.url,
      ...(b.style ? { style: b.style } : {}),
    }]),
  };

  primary.__fallbackMarkup = fallback;
  return primary;
}

async function safeAnswerCallback(app, q, text, alert = false) {
  try {
    await app.api.answerCallbackQuery(q.id, text, alert);
  } catch (e) {
    console.warn('answerCallbackQuery:', e.message);
  }
}

async function sendMainMenu(app, chatId) {
  const channel = await app.store.getChannelSettings();
  const channelLine = channel.id
    ? `📣 Канал: ${channel.title || channel.username || channel.id}`
    : '📣 Канал: не подключён';

  const text = [
    '🎛 Disconnect Post Manager',
    '',
    channelLine,
    '',
    'Создавай посты, храни их сколько угодно и публикуй только когда захочешь.',
  ].join('\n');

  await app.api.sendMessage(chatId, text, {
    reply_markup: kb(
      [btn('➕ Новый пост', 'main:new')],
      [btn('📝 Черновики', 'list:draft:0'), btn('✅ Готовые', 'list:ready:0')],
      [btn('📦 Архив', 'list:archive:0'), btn('📢 Опубликованные', 'list:published:0')],
      [btn('⚙️ Настройки', 'main:settings')],
    ),
  });
}

async function sendSettings(app, chatId) {
  const channel = await app.store.getChannelSettings();
  let text = '⚙️ Настройки\n\n';

  if (!channel.id) {
    text += '📣 Канал не подключён.\n\nНажми «Подключить канал» и отправь @username канала, его ID или перешли боту любой пост из канала.';
  } else {
    text += `📣 Канал: ${channel.title || '—'}\n`;
    text += `ID: ${channel.id}\n`;
    if (channel.username) text += `Username: @${channel.username}\n`;
    text += `\n💬 Группа обсуждений: ${channel.discussionGroupTitle || (channel.discussionGroupId ? channel.discussionGroupId : 'не привязана')}`;
  }

  await app.api.sendMessage(chatId, text, {
    reply_markup: kb(
      [btn(channel.id ? '🔄 Переподключить канал' : '➕ Подключить канал', 'settings:channel')],
      [btn('🧪 Проверить права бота', 'settings:check')],
      [btn('« Назад', 'main:menu')],
    ),
  });
}

async function listPosts(app, chatId, status, page = 0) {
  const limit = 8;
  const offsetRows = page * limit;
  const [rows, total] = await Promise.all([
    app.store.listPosts(status, limit, offsetRows),
    app.store.countPosts(status),
  ]);
  const title = {
    draft: '📝 Черновики',
    ready: '✅ Готовые',
    archive: '📦 Архив',
    published: '📢 Опубликованные',
  }[status] || status;

  const keyboard = rows.map((p) => [btn(`${mediaLabel(p.media_type)} · ${clampText(p.title, 34)}`, `post:${p.id}`)]);
  const nav = [];
  if (page > 0) nav.push(btn('‹', `list:${status}:${page - 1}`));
  if (offsetRows + rows.length < total) nav.push(btn('›', `list:${status}:${page + 1}`));
  if (nav.length) keyboard.push(nav);
  keyboard.push([btn('« Главное меню', 'main:menu')]);

  await app.api.sendMessage(chatId, `${title}\n\n${total ? `Всего: ${total}` : 'Пока пусто.'}`, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

function postCardText(post) {
  const buttonCount = post.buttons?.length ?? 0;
  const published = post.status === 'published';
  return [
    `#${post.id} · ${postStatusLabel(post.status)}`,
    `🏷 ${post.title}`,
    '',
    `${mediaLabel(post.media_type)}`,
    `🔘 Кнопки: ${buttonCount}`,
    `💬 Комментарии: ${post.comments_enabled ? 'вкл.' : 'выкл.'}`,
    `🔔 Звук: ${post.disable_notification ? 'выкл.' : 'вкл.'}`,
    `🔗 Предпросмотр ссылок: ${post.link_preview_enabled ? 'вкл.' : 'выкл.'}`,
    published ? `📅 Опубликован: ${formatDateTime(post.published_at)}` : `🕓 Изменён: ${formatDateTime(post.updated_at)}`,
    published && post.discussion_message_id ? `💬 Ветка обсуждения найдена: ${post.discussion_message_id}` : '',
  ].filter(Boolean).join('\n');
}

async function sendPostCard(app, chatId, postId) {
  const post = await app.store.getPost(postId);
  if (!post) {
    await app.api.sendMessage(chatId, 'Пост не найден.');
    return;
  }

  const rows = [
    [btn('👁 Предпросмотр', `p:preview:${post.id}`)],
    [btn('✏️ Текст / медиа', `p:edit:${post.id}`), btn('🏷 Название', `p:rename:${post.id}`)],
    [btn(`🔘 Кнопки (${post.buttons.length})`, `p:buttons:${post.id}`)],
    [btn(`💬 ${post.comments_enabled ? 'Комментарии: вкл.' : 'Комментарии: выкл.'}`, `p:comments:${post.id}`)],
    [btn(`🔔 ${post.disable_notification ? 'Без звука' : 'Со звуком'}`, `p:silent:${post.id}`), btn(`🔗 Preview: ${post.link_preview_enabled ? 'вкл.' : 'выкл.'}`, `p:linkpreview:${post.id}`)],
  ];

  if (post.status !== 'published') {
    rows.push([btn('✅ В готовые', `p:ready:${post.id}`), btn('📦 В архив', `p:archive:${post.id}`)]);
    rows.push([btn('🚀 Опубликовать', `p:publish:${post.id}`)]);
    rows.push([btn('🗑 Удалить', `p:delete:${post.id}`)]);
  } else {
    rows.push([btn('🔗 Открыть в канале', `p:open:${post.id}`)]);
  }
  rows.push([btn('« Главное меню', 'main:menu')]);

  await app.api.sendMessage(chatId, postCardText(post), { reply_markup: { inline_keyboard: rows } });
}

async function previewPost(app, chatId, postId) {
  const post = await app.store.getPost(postId);
  if (!post) return;
  const markup = await buildPublicMarkup(app.store, post.id, { customIcons: true });
  await app.api.sendMessage(chatId, `👁 Предпросмотр поста #${post.id}\n💬 Комментарии после публикации: ${post.comments_enabled ? 'вкл.' : 'выкл.'}`);
  await app.api.sendPost(chatId, post, markup, { preview: true });
}

async function sendButtonsMenu(app, chatId, postId) {
  const post = await app.store.getPost(postId);
  if (!post) return;
  const rows = post.buttons.map((b) => [btn(`${b.icon_fallback || ''} ${clampText(b.text, 28)}`.trim(), `button:${b.id}`)]);
  rows.push([btn('➕ Добавить кнопку', `buttons:add:${post.id}`)]);
  rows.push([btn('« К посту', `post:${post.id}`)]);
  await app.api.sendMessage(chatId, `🔘 Кнопки поста #${post.id}\n\nКаждая кнопка создаётся отдельной строкой. Ссылку, текст, цвет и custom emoji можно менять в любой момент.`, {
    reply_markup: { inline_keyboard: rows },
  });
}

function styleLabel(style) {
  return { danger: '🔴 Красный', success: '🟢 Зелёный', primary: '🔵 Синий' }[style] || '⚪ Стандартный';
}

async function sendButtonCard(app, chatId, buttonId) {
  const b = await app.store.getButton(buttonId);
  if (!b) return;
  const text = [
    `🔘 Кнопка #${b.id}`,
    '',
    `Текст: ${b.text}`,
    `URL: ${b.url}`,
    `Цвет: ${styleLabel(b.style)}`,
    `Иконка: ${b.icon_custom_emoji_id ? `${b.icon_fallback || 'custom emoji'} ✅` : 'нет'}`,
  ].join('\n');

  await app.api.sendMessage(chatId, text, {
    reply_markup: kb(
      [btn('✏️ Текст', `b:text:${b.id}`), btn('🔗 Ссылка', `b:url:${b.id}`)],
      [btn('🎨 Цвет', `b:style:${b.id}`), btn('🧩 Иконка', `b:icon:${b.id}`)],
      [btn('🗑 Удалить кнопку', `b:delete:${b.id}`)],
      [btn('« К кнопкам', `p:buttons:${b.post_id}`)],
    ),
  });
}

async function validateAndSaveChannel(app, target) {
  const chat = await app.api.getChat(target);
  if (chat.type !== 'channel') throw new Error('Это не канал Telegram.');

  const me = await app.api.getMe();
  const member = await app.api.getChatMember(chat.id, me.id);
  if (!['administrator', 'creator'].includes(member.status)) {
    throw new Error('Добавь бота администратором канала и повтори.');
  }
  if (member.status === 'administrator' && member.can_post_messages === false) {
    throw new Error('У бота нет права публиковать сообщения в канале.');
  }

  let discussionGroupTitle = '';
  const discussionGroupId = chat.linked_chat_id ? String(chat.linked_chat_id) : '';
  if (discussionGroupId) {
    try {
      const discussion = await app.api.getChat(discussionGroupId);
      discussionGroupTitle = discussion.title || '';
    } catch {
      discussionGroupTitle = '';
    }
  }

  await app.store.setChannelSettings({
    id: String(chat.id),
    title: chat.title || '',
    username: chat.username || '',
    discussionGroupId,
    discussionGroupTitle,
  });

  return { chat, member, discussionGroupId, discussionGroupTitle };
}

async function checkRights(app, chatId) {
  const channel = await app.store.getChannelSettings();
  if (!channel.id) {
    await app.api.sendMessage(chatId, 'Сначала подключи канал.');
    return;
  }

  const me = await app.api.getMe();
  const c = await app.api.getChat(channel.id);
  const member = await app.api.getChatMember(channel.id, me.id);
  const lines = [
    '🧪 Проверка прав',
    '',
    `📣 ${c.title}`,
    `Статус бота: ${member.status}`,
    `Публикация: ${member.status === 'creator' || member.can_post_messages ? '✅' : '❌'}`,
    `Редактирование: ${member.status === 'creator' || member.can_edit_messages ? '✅' : '❌'}`,
    `Удаление: ${member.status === 'creator' || member.can_delete_messages ? '✅' : '❌'}`,
  ];

  if (c.linked_chat_id) {
    try {
      const group = await app.api.getChat(c.linked_chat_id);
      const gm = await app.api.getChatMember(c.linked_chat_id, me.id);
      lines.push('', `💬 ${group.title}`, `Статус бота: ${gm.status}`, `Удаление ветки для отключения комментариев: ${gm.status === 'creator' || gm.can_delete_messages ? '✅' : '❌'}`);
      await app.store.setChannelSettings({
        id: String(c.id),
        title: c.title || '',
        username: c.username || '',
        discussionGroupId: String(c.linked_chat_id),
        discussionGroupTitle: group.title || '',
      });
    } catch {
      lines.push('', '💬 Группа обсуждений привязана, но бот не может её проверить. Добавь бота туда администратором.');
    }
  } else {
    lines.push('', '💬 К каналу не привязана группа обсуждений — комментариев у постов не будет.');
  }

  await app.api.sendMessage(chatId, lines.join('\n'));
}

async function updatePublishedMarkup(app, postId) {
  const post = await app.store.getPost(postId);
  if (!post || post.status !== 'published') return;
  const markup = await buildPublicMarkup(app.store, postId, { customIcons: true });
  if (!markup) {
    await app.api.editMessageReplyMarkup(post.published_chat_id, post.published_message_id, { inline_keyboard: [] });
    return;
  }
  const fallback = markup.__fallbackMarkup;
  const primary = { ...markup };
  delete primary.__fallbackMarkup;
  try {
    await app.api.editMessageReplyMarkup(post.published_chat_id, post.published_message_id, primary);
  } catch (e) {
    const usesCustom = JSON.stringify(primary).includes('icon_custom_emoji_id');
    if (!usesCustom) throw e;
    await app.api.editMessageReplyMarkup(post.published_chat_id, post.published_message_id, fallback);
  }
}

async function publishPost(app, chatId, postId) {
  const channel = await app.store.getChannelSettings();
  if (!channel.id) {
    await app.api.sendMessage(chatId, 'Сначала подключи канал в ⚙️ Настройках.');
    return;
  }
  const post = await app.store.getPost(postId);
  if (!post) return;
  if (post.status === 'published') {
    await app.api.sendMessage(chatId, 'Этот пост уже опубликован.');
    return;
  }

  const markup = await buildPublicMarkup(app.store, post.id, { customIcons: true });
  const sent = await app.api.sendPost(channel.id, post, markup, { preview: false });
  await app.store.markPublished(post.id, channel.id, sent.message_id);

  await app.api.sendMessage(chatId, `✅ Пост #${post.id} опубликован.\n\n${post.comments_enabled ? '💬 Комментарии оставлены включёнными.' : '💬 Комментарии будут отключены, когда Telegram пришлёт автоматическую копию в группу обсуждений.'}`);
  await sendPostCard(app, chatId, post.id);
}

async function toggleComments(app, chatId, postId) {
  const post = await app.store.getPost(postId);
  if (!post) return;

  if (post.status !== 'published') {
    await app.store.setBool(postId, 'comments_enabled', !post.comments_enabled);
    await sendPostCard(app, chatId, postId);
    return;
  }

  if (!post.comments_enabled) {
    await app.api.sendMessage(chatId, 'После удаления автоматической копии поста Telegram не предоставляет Bot API-метод, который создаст эту ветку комментариев заново. Поэтому повторно включить комментарии для уже опубликованного поста бот не будет.');
    return;
  }

  if (!post.discussion_chat_id || !post.discussion_message_id) {
    await app.api.sendMessage(chatId, 'Я ещё не нашёл автоматическую копию этого поста в группе обсуждений. Проверь, что бот добавлен в связанную группу.');
    return;
  }

  try {
    await app.api.deleteMessage(post.discussion_chat_id, post.discussion_message_id);
    await app.store.markCommentsDisabled(postId);
    await app.api.sendMessage(chatId, '💬 Комментарии для этого поста отключены.');
  } catch (e) {
    await app.api.sendMessage(chatId, `Не удалось удалить ветку комментариев. Проверь права бота и ограничения Telegram.\n\n${e.message}`);
  }
}

async function handleAutomaticForward(app, message) {
  if (!message?.is_automatic_forward) return false;
  const origin = message.forward_origin;
  if (origin?.type !== 'channel' || !origin.chat?.id || !origin.message_id) return false;

  const post = await app.store.findPublishedPost(origin.chat.id, origin.message_id);
  if (!post) return false;

  await app.store.setDiscussionMessage(post.id, message.chat.id, message.message_id);
  if (!post.comments_enabled) {
    try {
      await app.api.deleteMessage(message.chat.id, message.message_id);
      await app.store.markCommentsDisabled(post.id);
      console.log(`Comments disabled for post #${post.id}`);
    } catch (e) {
      console.warn(`Не удалось отключить комментарии поста #${post.id}:`, e.message);
    }
  }
  return true;
}

async function handleOwnerMessage(app, message) {
  const userId = message.from?.id;
  const chatId = message.chat?.id;
  if (!userId || !chatId || message.chat.type !== 'private') return;

  const text = message.text?.trim() || '';
  const ownerId = await app.store.getOwnerId();

  if (!ownerId) {
    if (text.startsWith('/claim')) {
      const code = text.split(/\s+/).slice(1).join(' ');
      if (!app.env.SETUP_CODE) {
        await app.api.sendMessage(chatId, 'SETUP_CODE не задан в Cloudflare Secrets.');
        return;
      }
      if (code !== app.env.SETUP_CODE) {
        await app.api.sendMessage(chatId, '❌ Неверный код активации.');
        return;
      }
      await app.store.setOwnerId(userId);
      await app.api.sendMessage(chatId, '✅ Ты назначен владельцем этого бота.');
      await sendMainMenu(app, chatId);
      return;
    }

    await app.api.sendMessage(chatId, '🔐 Бот ещё не активирован.\n\nОтправь:\n/claim КОД_ИЗ_CLOUDFLARE');
    return;
  }

  if (Number(userId) !== Number(ownerId)) return;

  if (text === '/start' || text === '/menu') {
    await app.store.clearSession(userId);
    await sendMainMenu(app, chatId);
    return;
  }
  if (text === '/cancel') {
    await app.store.clearSession(userId);
    await app.api.sendMessage(chatId, 'Отменено.');
    await sendMainMenu(app, chatId);
    return;
  }

  const session = await app.store.getSession(userId);
  if (!session) {
    await sendMainMenu(app, chatId);
    return;
  }

  if (session.action === 'new_post_content') {
    if (message.media_group_id) {
      await app.api.sendMessage(chatId, 'В версии 1.1 альбомы из нескольких медиа пока не поддерживаются. Отправь одно фото/видео или текст.');
      return;
    }
    const content = contentFromMessage(message);
    if (!content.text && !content.mediaType) {
      await app.api.sendMessage(chatId, 'Отправь текст, фото, видео, GIF/анимацию или документ.');
      return;
    }
    const postId = await app.store.createPost(content);
    await app.store.clearSession(userId);
    await app.api.sendMessage(chatId, `✅ Черновик #${postId} создан.`);
    await sendPostCard(app, chatId, postId);
    return;
  }

  if (session.action === 'rename_post') {
    if (!text || text.startsWith('/')) {
      await app.api.sendMessage(chatId, 'Отправь новое название обычным текстом.');
      return;
    }
    await app.store.renamePost(session.postId, text.slice(0, 120));
    await app.store.clearSession(userId);
    await sendPostCard(app, chatId, session.postId);
    return;
  }

  if (session.action === 'edit_post_content') {
    if (message.media_group_id) {
      await app.api.sendMessage(chatId, 'Альбомы пока не поддерживаются. Отправь один файл или текст.');
      return;
    }
    const post = await app.store.getPost(session.postId);
    if (!post) return;
    const next = contentFromMessage(message);
    if (!next.text && !next.mediaType) {
      await app.api.sendMessage(chatId, 'Нужен текст или поддерживаемое медиа.');
      return;
    }

    if (post.status === 'published') {
      if (!post.media_type && next.mediaType) {
        await app.api.sendMessage(chatId, 'Telegram не позволяет превратить уже опубликованный текстовый пост в медиа-пост. Текст редактировать можно; для медиа создай новый пост.');
        return;
      }
      if (post.media_type && !next.mediaType) {
        next.mediaType = null;
        next.mediaFileId = null;
      }
      const markup = await buildPublicMarkup(app.store, post.id, { customIcons: true });
      await app.api.editPublishedContent(post, next, markup);
      if (post.media_type && !next.mediaType) {
        await app.store.updatePostText(post.id, next.text, next.entities, 'edit_published_caption');
      } else if (post.media_type && next.mediaType) {
        await app.store.updatePostMedia(post.id, next.mediaType, next.mediaFileId, next.text, next.entities, 'edit_published_media');
      } else {
        await app.store.updatePostText(post.id, next.text, next.entities, 'edit_published_text');
      }
    } else {
      await app.store.updatePostContent(post.id, next);
    }

    await app.store.clearSession(userId);
    await app.api.sendMessage(chatId, '✅ Пост обновлён.');
    await sendPostCard(app, chatId, post.id);
    return;
  }

  if (session.action === 'connect_channel') {
    let target = text;
    if (message.forward_origin?.type === 'channel') {
      target = message.forward_origin.chat.id;
    }
    if (!target) {
      await app.api.sendMessage(chatId, 'Отправь @username, числовой ID канала или перешли пост из канала.');
      return;
    }
    try {
      const result = await validateAndSaveChannel(app, target);
      await app.store.clearSession(userId);
      await app.api.sendMessage(chatId, `✅ Канал подключён: ${result.chat.title}\n💬 Группа обсуждений: ${result.discussionGroupTitle || (result.discussionGroupId ? result.discussionGroupId : 'не привязана')}`);
      await sendSettings(app, chatId);
    } catch (e) {
      await app.api.sendMessage(chatId, `❌ Не удалось подключить канал:\n${e.message}`);
    }
    return;
  }

  if (session.action === 'add_button_label') {
    if (!text) {
      await app.api.sendMessage(chatId, 'Отправь название кнопки. Можно начать его с Telegram custom emoji.');
      return;
    }
    const icon = findFirstCustomEmoji(message.text, message.entities ?? []);
    const label = icon?.label || text;
    if (!label) {
      await app.api.sendMessage(chatId, 'После custom emoji должен быть текст кнопки, например: [emoji] Смотреть на YouTube');
      return;
    }
    await app.store.setSession(userId, {
      action: 'add_button_url',
      postId: session.postId,
      temp: {
        text: label.slice(0, 64),
        iconCustomEmojiId: icon?.id ?? null,
        iconFallback: icon?.fallback ?? null,
      },
    });
    await app.api.sendMessage(chatId, '🔗 Теперь отправь ссылку кнопки (https://… или tg://…).');
    return;
  }

  if (session.action === 'add_button_url') {
    if (!isValidButtonUrl(text)) {
      await app.api.sendMessage(chatId, 'Ссылка должна начинаться с http://, https:// или tg://');
      return;
    }
    await app.store.setSession(userId, { ...session, action: 'add_button_style', temp: { ...session.temp, url: text } });
    await app.api.sendMessage(chatId, '🎨 Выбери цвет кнопки:', {
      reply_markup: kb(
        [btn('⚪ Стандартный', 'newbtnstyle:none')],
        [btn('🔵 Синий', 'newbtnstyle:primary'), btn('🟢 Зелёный', 'newbtnstyle:success')],
        [btn('🔴 Красный', 'newbtnstyle:danger')],
      ),
    });
    return;
  }

  if (session.action === 'edit_button_text') {
    if (!text) return;
    const icon = findFirstCustomEmoji(message.text, message.entities ?? []);
    const label = icon?.label || text;
    const patch = { text: label.slice(0, 64) };
    if (icon) {
      patch.icon_custom_emoji_id = icon.id;
      patch.icon_fallback = icon.fallback;
    }
    const b = await app.store.updateButton(session.buttonId, patch);
    await app.store.clearSession(userId);
    if (b) await updatePublishedMarkup(app, b.post_id);
    await sendButtonCard(app, chatId, session.buttonId);
    return;
  }

  if (session.action === 'edit_button_url') {
    if (!isValidButtonUrl(text)) {
      await app.api.sendMessage(chatId, 'Ссылка должна начинаться с http://, https:// или tg://');
      return;
    }
    const b = await app.store.updateButton(session.buttonId, { url: text });
    await app.store.clearSession(userId);
    if (b) await updatePublishedMarkup(app, b.post_id);
    await sendButtonCard(app, chatId, session.buttonId);
    return;
  }

  if (session.action === 'edit_button_icon') {
    const icon = findFirstCustomEmoji(message.text || '', message.entities ?? []);
    if (!icon) {
      await app.api.sendMessage(chatId, 'Отправь именно Telegram custom emoji одним сообщением либо нажми «Без иконки».');
      return;
    }
    const b = await app.store.updateButton(session.buttonId, {
      icon_custom_emoji_id: icon.id,
      icon_fallback: icon.fallback,
    });
    await app.store.clearSession(userId);
    if (b) await updatePublishedMarkup(app, b.post_id);
    await sendButtonCard(app, chatId, session.buttonId);
  }
}

async function handleCallback(app, q) {
  const userId = q.from?.id;
  const chatId = q.message?.chat?.id;
  const data = q.data || '';
  if (!userId || !chatId || !(await ownerOnly(app.store, userId))) {
    await safeAnswerCallback(app, q, 'Нет доступа', true);
    return;
  }

  await safeAnswerCallback(app, q);

  if (data === 'main:menu') {
    await app.store.clearSession(userId);
    await sendMainMenu(app, chatId);
    return;
  }
  if (data === 'main:new') {
    await app.store.setSession(userId, { action: 'new_post_content' });
    await app.api.sendMessage(chatId, '➕ Новый пост\n\nОтправь одним сообщением текст, фото, видео, GIF/анимацию или документ. Форматирование Telegram сохранится.\n\n/cancel — отменить.');
    return;
  }
  if (data === 'main:settings') {
    await app.store.clearSession(userId);
    await sendSettings(app, chatId);
    return;
  }
  if (data === 'settings:channel') {
    await app.store.setSession(userId, { action: 'connect_channel' });
    await app.api.sendMessage(chatId, '📣 Подключение канала\n\nОтправь @username канала, его числовой ID или перешли сюда любой пост из канала.\n\nПеред этим добавь этого бота администратором канала.');
    return;
  }
  if (data === 'settings:check') {
    try {
      await checkRights(app, chatId);
    } catch (e) {
      await app.api.sendMessage(chatId, `❌ Ошибка проверки:\n${e.message}`);
    }
    return;
  }

  if (data.startsWith('list:')) {
    const [, status, pageRaw] = data.split(':');
    await listPosts(app, chatId, status, Number(pageRaw || 0));
    return;
  }

  if (data.startsWith('post:')) {
    await sendPostCard(app, chatId, Number(data.split(':')[1]));
    return;
  }

  if (data.startsWith('p:preview:')) {
    await previewPost(app, chatId, Number(data.split(':')[2]));
    return;
  }
  if (data.startsWith('p:edit:')) {
    const postId = Number(data.split(':')[2]);
    await app.store.setSession(userId, { action: 'edit_post_content', postId });
    const post = await app.store.getPost(postId);
    const note = post?.status === 'published'
      ? '\n\nДля медиа-поста: обычный текст изменит подпись; новое фото/видео заменит медиа. Текстовый опубликованный пост нельзя превратить в медиа.'
      : '';
    await app.api.sendMessage(chatId, `✏️ Отправь новую версию содержимого поста #${postId}.${note}\n\n/cancel — отменить.`);
    return;
  }
  if (data.startsWith('p:rename:')) {
    const postId = Number(data.split(':')[2]);
    await app.store.setSession(userId, { action: 'rename_post', postId });
    await app.api.sendMessage(chatId, '🏷 Отправь внутреннее название поста. Оно видно только тебе в списках.');
    return;
  }
  if (data.startsWith('p:buttons:')) {
    await sendButtonsMenu(app, chatId, Number(data.split(':')[2]));
    return;
  }
  if (data.startsWith('p:comments:')) {
    await toggleComments(app, chatId, Number(data.split(':')[2]));
    return;
  }
  if (data.startsWith('p:silent:')) {
    const postId = Number(data.split(':')[2]);
    const post = await app.store.getPost(postId);
    if (!post) return;
    if (post.status === 'published') {
      await app.api.sendMessage(chatId, 'Звуковое уведомление задаётся только в момент публикации и не меняется задним числом.');
      return;
    }
    await app.store.setBool(postId, 'disable_notification', !post.disable_notification);
    await sendPostCard(app, chatId, postId);
    return;
  }
  if (data.startsWith('p:linkpreview:')) {
    const postId = Number(data.split(':')[2]);
    const post = await app.store.getPost(postId);
    if (!post) return;
    await app.store.setBool(postId, 'link_preview_enabled', !post.link_preview_enabled);
    if (post.status === 'published' && !post.media_type) {
      const fresh = await app.store.getPost(postId);
      const markup = await buildPublicMarkup(app.store, postId, { customIcons: true });
      await app.api.editPublishedContent(post, {
        text: fresh.text,
        entities: fresh.entities,
        mediaType: null,
        mediaFileId: null,
      }, markup);
    }
    await sendPostCard(app, chatId, postId);
    return;
  }
  if (data.startsWith('p:ready:')) {
    const postId = Number(data.split(':')[2]);
    await app.store.setPostStatus(postId, 'ready');
    await sendPostCard(app, chatId, postId);
    return;
  }
  if (data.startsWith('p:archive:')) {
    const postId = Number(data.split(':')[2]);
    await app.store.setPostStatus(postId, 'archive');
    await sendPostCard(app, chatId, postId);
    return;
  }
  if (data.startsWith('p:publish:')) {
    const postId = Number(data.split(':')[2]);
    await app.api.sendMessage(chatId, `🚀 Опубликовать пост #${postId} сейчас?`, {
      reply_markup: kb([btn('✅ Да, опубликовать', `confirm:publish:${postId}`), btn('Отмена', `post:${postId}`)]),
    });
    return;
  }
  if (data.startsWith('confirm:publish:')) {
    await publishPost(app, chatId, Number(data.split(':')[2]));
    return;
  }
  if (data.startsWith('p:delete:')) {
    const postId = Number(data.split(':')[2]);
    await app.api.sendMessage(chatId, `Удалить сохранённый пост #${postId} из базы?`, {
      reply_markup: kb([btn('🗑 Да', `confirm:delete:${postId}`), btn('Отмена', `post:${postId}`)]),
    });
    return;
  }
  if (data.startsWith('confirm:delete:')) {
    const postId = Number(data.split(':')[2]);
    const post = await app.store.getPost(postId);
    if (post?.status === 'published') {
      await app.api.sendMessage(chatId, 'Опубликованные посты этой кнопкой не удаляются.');
      return;
    }
    await app.store.deletePost(postId);
    await app.api.sendMessage(chatId, `🗑 Пост #${postId} удалён из базы.`);
    return;
  }
  if (data.startsWith('p:open:')) {
    const postId = Number(data.split(':')[2]);
    const post = await app.store.getPost(postId);
    const channel = await app.store.getChannelSettings();
    if (!post?.published_message_id) return;
    if (channel.username) {
      await app.api.sendMessage(chatId, `https://t.me/${channel.username}/${post.published_message_id}`);
    } else {
      await app.api.sendMessage(chatId, `Пост #${post.published_message_id} опубликован в приватном канале «${channel.title || channel.id}». Прямая публичная ссылка недоступна без username.`);
    }
    return;
  }

  if (data.startsWith('buttons:add:')) {
    const postId = Number(data.split(':')[2]);
    await app.store.setSession(userId, { action: 'add_button_label', postId });
    await app.api.sendMessage(chatId, '🔘 Отправь текст новой кнопки.\n\nЧтобы использовать Telegram custom emoji как настоящую иконку кнопки, поставь его первым перед текстом, например:\n[custom emoji] Смотреть на YouTube');
    return;
  }
  if (data.startsWith('button:')) {
    await sendButtonCard(app, chatId, Number(data.split(':')[1]));
    return;
  }
  if (data.startsWith('b:text:')) {
    const buttonId = Number(data.split(':')[2]);
    await app.store.setSession(userId, { action: 'edit_button_text', buttonId });
    await app.api.sendMessage(chatId, '✏️ Отправь новый текст кнопки. Если первым поставить custom emoji, он одновременно станет иконкой.');
    return;
  }
  if (data.startsWith('b:url:')) {
    const buttonId = Number(data.split(':')[2]);
    await app.store.setSession(userId, { action: 'edit_button_url', buttonId });
    await app.api.sendMessage(chatId, '🔗 Отправь новую ссылку.');
    return;
  }
  if (data.startsWith('b:style:')) {
    const buttonId = Number(data.split(':')[2]);
    await app.api.sendMessage(chatId, '🎨 Выбери цвет:', {
      reply_markup: kb(
        [btn('⚪ Стандартный', `setstyle:${buttonId}:none`)],
        [btn('🔵 Синий', `setstyle:${buttonId}:primary`), btn('🟢 Зелёный', `setstyle:${buttonId}:success`)],
        [btn('🔴 Красный', `setstyle:${buttonId}:danger`)],
      ),
    });
    return;
  }
  if (data.startsWith('setstyle:')) {
    const [, idRaw, styleRaw] = data.split(':');
    const b = await app.store.updateButton(Number(idRaw), { style: styleRaw === 'none' ? null : styleRaw });
    if (b) await updatePublishedMarkup(app, b.post_id);
    await sendButtonCard(app, chatId, Number(idRaw));
    return;
  }
  if (data.startsWith('b:icon:')) {
    const buttonId = Number(data.split(':')[2]);
    await app.store.setSession(userId, { action: 'edit_button_icon', buttonId });
    await app.api.sendMessage(chatId, '🧩 Отправь Telegram custom emoji.\n\nИли убери иконку:', {
      reply_markup: kb([btn('🚫 Без иконки', `clearicon:${buttonId}`)]),
    });
    return;
  }
  if (data.startsWith('clearicon:')) {
    const buttonId = Number(data.split(':')[1]);
    const b = await app.store.updateButton(buttonId, { icon_custom_emoji_id: null, icon_fallback: null });
    await app.store.clearSession(userId);
    if (b) await updatePublishedMarkup(app, b.post_id);
    await sendButtonCard(app, chatId, buttonId);
    return;
  }
  if (data.startsWith('b:delete:')) {
    const buttonId = Number(data.split(':')[2]);
    const b = await app.store.getButton(buttonId);
    if (!b) return;
    await app.api.sendMessage(chatId, `Удалить кнопку «${b.text}»?`, {
      reply_markup: kb([btn('🗑 Да', `confirm:bdel:${buttonId}`), btn('Отмена', `button:${buttonId}`)]),
    });
    return;
  }
  if (data.startsWith('confirm:bdel:')) {
    const buttonId = Number(data.split(':')[2]);
    const removed = await app.store.deleteButton(buttonId);
    if (removed) {
      await updatePublishedMarkup(app, removed.post_id);
      await sendButtonsMenu(app, chatId, removed.post_id);
    }
    return;
  }
  if (data.startsWith('newbtnstyle:')) {
    const styleRaw = data.split(':')[1];
    const session = await app.store.getSession(userId);
    if (!session || session.action !== 'add_button_style') {
      await app.api.sendMessage(chatId, 'Сессия создания кнопки уже закончилась. Начни заново.');
      return;
    }
    const id = await app.store.addButton(session.postId, {
      ...session.temp,
      style: styleRaw === 'none' ? null : styleRaw,
    });
    await app.store.clearSession(userId);
    const post = await app.store.getPost(session.postId);
    if (post?.status === 'published') await updatePublishedMarkup(app, post.id);
    await app.api.sendMessage(chatId, `✅ Кнопка #${id} добавлена.`);
    await sendButtonsMenu(app, chatId, session.postId);
  }
}

async function handleUpdate(app, update) {
  if (update.message) {
    if (await handleAutomaticForward(app, update.message)) return;
    await handleOwnerMessage(app, update.message);
    return;
  }
  if (update.callback_query) {
    await handleCallback(app, update.callback_query);
  }
}

function createApp(env) {
  return {
    env,
    api: new TelegramApi(env.BOT_TOKEN),
    store: new Store(env.DB),
  };
}

async function requireConfigured(env) {
  const missing = [];
  if (!env.DB) missing.push('DB binding');
  if (!env.BOT_TOKEN) missing.push('BOT_TOKEN');
  if (!env.SETUP_CODE) missing.push('SETUP_CODE');
  if (!env.WEBHOOK_SECRET) missing.push('WEBHOOK_SECRET');
  if (missing.length) throw new Error(`Не настроено: ${missing.join(', ')}`);
}

async function setupWebhook(request, env) {
  await requireConfigured(env);
  const url = new URL(request.url);
  if (url.searchParams.get('code') !== env.SETUP_CODE) {
    return new Response('Forbidden', { status: 403 });
  }

  const app = createApp(env);
  await app.store.ensureSchema();
  const me = await app.api.getMe();
  const webhookUrl = `${url.origin}/telegram`;
  await app.api.setWebhook(webhookUrl, env.WEBHOOK_SECRET);
  const info = await app.api.getWebhookInfo();

  return Response.json({
    ok: true,
    bot: `@${me.username}`,
    webhook: webhookUrl,
    telegram_webhook_info: {
      url: info.url,
      pending_update_count: info.pending_update_count,
      last_error_date: info.last_error_date ?? null,
      last_error_message: info.last_error_message ?? null,
    },
    next: `Открой Telegram и отправь /claim ${env.SETUP_CODE}`,
  });
}

async function status(request, env) {
  await requireConfigured(env);
  const url = new URL(request.url);
  if (url.searchParams.get('code') !== env.SETUP_CODE) {
    return new Response('Forbidden', { status: 403 });
  }
  const app = createApp(env);
  await app.store.ensureSchema();
  const [me, info, ownerId, channel] = await Promise.all([
    app.api.getMe(),
    app.api.getWebhookInfo(),
    app.store.getOwnerId(),
    app.store.getChannelSettings(),
  ]);
  return Response.json({
    ok: true,
    bot: { id: me.id, username: me.username },
    owner_claimed: Boolean(ownerId),
    channel_connected: Boolean(channel.id),
    channel: channel.id ? { id: channel.id, title: channel.title, username: channel.username } : null,
    webhook: {
      url: info.url,
      pending_update_count: info.pending_update_count,
      last_error_date: info.last_error_date ?? null,
      last_error_message: info.last_error_message ?? null,
    },
  });
}

async function telegramWebhook(request, env) {
  await requireConfigured(env);
  const suppliedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!suppliedSecret || suppliedSecret !== env.WEBHOOK_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }

  const app = createApp(env);
  await app.store.ensureSchema();
  const update = await request.json();

  try {
    await handleUpdate(app, update);
  } catch (e) {
    console.error('Update handler error:', e?.stack || e);

    // Return 200 after reporting the error to avoid Telegram replaying a publish action
    // and accidentally creating a duplicate channel post.
    try {
      const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
      const userId = update.message?.from?.id || update.callback_query?.from?.id;
      if (chatId && userId && await ownerOnly(app.store, userId)) {
        const detail = e instanceof TelegramApiError ? e.description : (e?.message || String(e));
        await app.api.sendMessage(chatId, `⚠️ Ошибка:\n${detail}`);
      }
    } catch (notifyError) {
      console.error('Could not notify owner:', notifyError?.message || notifyError);
    }
  }

  return new Response('OK');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return Response.json({
        ok: true,
        service: 'Disconnect Post Manager',
        runtime: 'Cloudflare Workers + D1',
        version: '1.1.0',
      });
    }

    if (request.method === 'GET' && url.pathname === '/setup') {
      try {
        return await setupWebhook(request, env);
      } catch (e) {
        console.error('Setup error:', e?.stack || e);
        return Response.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
      }
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      try {
        return await status(request, env);
      } catch (e) {
        return Response.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
      }
    }

    if (request.method === 'POST' && url.pathname === '/telegram') {
      try {
        return await telegramWebhook(request, env);
      } catch (e) {
        console.error('Webhook entry error:', e?.stack || e);
        return new Response('Configuration error', { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  },
};
