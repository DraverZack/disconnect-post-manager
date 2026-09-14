import { stripCustomEmojiEntities } from './utils.js';

export class TelegramApiError extends Error {
  constructor(method, response) {
    super(`${method}: ${response?.description ?? 'Telegram API error'}`);
    this.name = 'TelegramApiError';
    this.method = method;
    this.response = response;
    this.errorCode = response?.error_code;
    this.description = response?.description ?? '';
  }
}

export class TelegramApi {
  constructor(token) {
    if (!token) throw new Error('BOT_TOKEN is not configured');
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async call(method, params = {}) {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const body = await res.json().catch(() => null);
    if (!body?.ok) throw new TelegramApiError(method, body);
    return body.result;
  }

  getMe() {
    return this.call('getMe');
  }

  getChat(chatId) {
    return this.call('getChat', { chat_id: chatId });
  }

  getChatMember(chatId, userId) {
    return this.call('getChatMember', { chat_id: chatId, user_id: userId });
  }

  setWebhook(url, secretToken) {
    return this.call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
      max_connections: 20,
    });
  }

  getWebhookInfo() {
    return this.call('getWebhookInfo');
  }

  sendMessage(chatId, text, options = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, ...options });
  }

  editMessageText(chatId, messageId, text, options = {}) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...options,
    });
  }

  editMessageCaption(chatId, messageId, caption, options = {}) {
    return this.call('editMessageCaption', {
      chat_id: chatId,
      message_id: messageId,
      caption,
      ...options,
    });
  }

  editMessageMedia(chatId, messageId, media, options = {}) {
    return this.call('editMessageMedia', {
      chat_id: chatId,
      message_id: messageId,
      media,
      ...options,
    });
  }

  editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    return this.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  }

  deleteMessage(chatId, messageId) {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  answerCallbackQuery(id, text = undefined, showAlert = false) {
    return this.call('answerCallbackQuery', {
      callback_query_id: id,
      ...(text ? { text } : {}),
      ...(showAlert ? { show_alert: true } : {}),
    });
  }

  async sendPost(chatId, post, replyMarkup, { preview = false } = {}) {
    const fallbackMarkup = replyMarkup?.__fallbackMarkup ?? null;
    const primaryMarkup = replyMarkup ? { ...replyMarkup } : undefined;
    if (primaryMarkup) delete primaryMarkup.__fallbackMarkup;

    const common = {
      disable_notification: preview ? true : post.disable_notification,
      reply_markup: primaryMarkup,
    };

    const withEntities = post.entities?.length ? post.entities : undefined;
    const fallbackEntities = stripCustomEmojiEntities(post.entities ?? []);

    const send = async (entities, markup) => {
      if (!post.media_type) {
        if (!post.text) throw new Error('Пустой текстовый пост нельзя отправить.');
        return this.call('sendMessage', {
          chat_id: chatId,
          text: post.text,
          ...(entities?.length ? { entities } : {}),
          link_preview_options: { is_disabled: !post.link_preview_enabled },
          ...common,
          reply_markup: markup,
        });
      }

      const method = {
        photo: 'sendPhoto',
        video: 'sendVideo',
        animation: 'sendAnimation',
        document: 'sendDocument',
      }[post.media_type];
      if (!method) throw new Error(`Неподдерживаемый тип медиа: ${post.media_type}`);

      const mediaField = {
        photo: 'photo',
        video: 'video',
        animation: 'animation',
        document: 'document',
      }[post.media_type];

      return this.call(method, {
        chat_id: chatId,
        [mediaField]: post.media_file_id,
        ...(post.text ? { caption: post.text } : {}),
        ...(post.text && entities?.length ? { caption_entities: entities } : {}),
        ...common,
        reply_markup: markup,
      });
    };

    try {
      return await send(withEntities, primaryMarkup);
    } catch (error) {
      // Telegram has extra restrictions for custom emoji in channels/buttons.
      const customEmojiWasUsed = (post.entities ?? []).some((e) => e?.type === 'custom_emoji')
        || JSON.stringify(primaryMarkup ?? {}).includes('icon_custom_emoji_id');
      if (!customEmojiWasUsed) throw error;
      return send(fallbackEntities, fallbackMarkup ?? primaryMarkup);
    }
  }

  async editPublishedContent(post, nextContent, replyMarkup) {
    const chatId = post.published_chat_id;
    const messageId = post.published_message_id;
    const entities = nextContent.entities ?? [];
    const fallbackEntities = stripCustomEmojiEntities(entities);

    const fallbackMarkup = replyMarkup?.__fallbackMarkup ?? null;
    const primaryMarkup = replyMarkup ? { ...replyMarkup } : undefined;
    if (primaryMarkup) delete primaryMarkup.__fallbackMarkup;

    const attempt = async (ents, markup) => {
      if (!post.media_type) {
        if (nextContent.mediaType) {
          throw new Error('Опубликованный текстовый пост нельзя превратить в медиа-пост через Bot API. Создай новый пост.');
        }
        return this.call('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: nextContent.text,
          ...(ents.length ? { entities: ents } : {}),
          link_preview_options: { is_disabled: !post.link_preview_enabled },
          reply_markup: markup,
        });
      }

      if (!nextContent.mediaType) {
        return this.call('editMessageCaption', {
          chat_id: chatId,
          message_id: messageId,
          caption: nextContent.text ?? '',
          ...(ents.length ? { caption_entities: ents } : {}),
          reply_markup: markup,
        });
      }

      const media = {
        type: nextContent.mediaType,
        media: nextContent.mediaFileId,
        ...(nextContent.text ? { caption: nextContent.text } : {}),
        ...(nextContent.text && ents.length ? { caption_entities: ents } : {}),
      };
      return this.call('editMessageMedia', {
        chat_id: chatId,
        message_id: messageId,
        media,
        reply_markup: markup,
      });
    };

    try {
      return await attempt(entities, primaryMarkup);
    } catch (error) {
      const customEmojiWasUsed = entities.some((e) => e?.type === 'custom_emoji')
        || JSON.stringify(primaryMarkup ?? {}).includes('icon_custom_emoji_id');
      if (!customEmojiWasUsed) throw error;
      return attempt(fallbackEntities, fallbackMarkup ?? primaryMarkup);
    }
  }
}
