/**
 * WhatsAppButtons — utility module for building WhatsApp interactive message payloads.
 *
 * Supports two interaction types:
 *   - Quick reply buttons (up to 3 buttons, each with an ID and display label)
 *   - List messages (sectioned menu of up to 10 rows selectable from a list picker)
 *
 * These payloads are consumed by WhatsAppProvider.sendQuickReply() and
 * WhatsAppProvider.sendListMessage() respectively.
 */

// Maximum constraints imposed by the WhatsApp Business API
const MAX_QUICK_REPLY_BUTTONS = 3;
const MAX_BUTTON_TITLE_LEN    = 20;
const MAX_LIST_SECTIONS       = 10;
const MAX_LIST_ROW_TITLE_LEN  = 24;
const MAX_LIST_ROW_DESC_LEN   = 72;
const MAX_LIST_BUTTON_LEN     = 20;

/**
 * Build a quick-reply button payload.
 *
 * @param {string} bodyText  - Main message body shown above the buttons.
 * @param {Array<{id: string, title: string}>} buttons
 *   Array of button descriptors (max 3). Each must have:
 *     id    — unique string sent back in the webhook when the user taps the button
 *     title — label shown on the button face (max 20 chars)
 * @param {object} [opts]
 * @param {string} [opts.header]  - Optional header text (bold, shown above body).
 * @param {string} [opts.footer]  - Optional footer text (italic, shown below buttons).
 * @returns {{ type: 'quick_reply', payload: object }}
 */
function buildQuickReply(bodyText, buttons, opts = {}) {
  if (!bodyText || typeof bodyText !== 'string') {
    throw new Error('buildQuickReply: bodyText must be a non-empty string');
  }
  if (!Array.isArray(buttons) || buttons.length === 0) {
    throw new Error('buildQuickReply: buttons must be a non-empty array');
  }
  if (buttons.length > MAX_QUICK_REPLY_BUTTONS) {
    throw new Error(`buildQuickReply: maximum ${MAX_QUICK_REPLY_BUTTONS} buttons allowed`);
  }

  const validatedButtons = buttons.map((btn, i) => {
    if (!btn.id || typeof btn.id !== 'string') {
      throw new Error(`buildQuickReply: button[${i}].id must be a non-empty string`);
    }
    if (!btn.title || typeof btn.title !== 'string') {
      throw new Error(`buildQuickReply: button[${i}].title must be a non-empty string`);
    }
    const title = btn.title.slice(0, MAX_BUTTON_TITLE_LEN);
    return { type: 'reply', reply: { id: btn.id, title } };
  });

  const payload = {
    type: 'button',
    body: { text: bodyText },
    action: { buttons: validatedButtons },
  };

  if (opts.header) payload.header = { type: 'text', text: opts.header };
  if (opts.footer) payload.footer = { text: opts.footer };

  return { type: 'quick_reply', payload };
}

/**
 * Build a list message payload (sectioned menu).
 *
 * @param {string} bodyText  - Main message body shown above the list button.
 * @param {string} buttonLabel - Label for the button that opens the list picker (max 20 chars).
 * @param {Array<{ title: string, rows: Array<{id: string, title: string, description?: string}> }>} sections
 *   Array of sections, each containing a title and 1–10 row items.
 *   Row fields:
 *     id          — unique string returned in the webhook on selection
 *     title       — row display title (max 24 chars)
 *     description — optional subtitle (max 72 chars)
 * @param {object} [opts]
 * @param {string} [opts.header] - Optional header text.
 * @param {string} [opts.footer] - Optional footer text.
 * @returns {{ type: 'list', payload: object }}
 */
function buildListMessage(bodyText, buttonLabel, sections, opts = {}) {
  if (!bodyText || typeof bodyText !== 'string') {
    throw new Error('buildListMessage: bodyText must be a non-empty string');
  }
  if (!buttonLabel || typeof buttonLabel !== 'string') {
    throw new Error('buildListMessage: buttonLabel must be a non-empty string');
  }
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error('buildListMessage: sections must be a non-empty array');
  }
  if (sections.length > MAX_LIST_SECTIONS) {
    throw new Error(`buildListMessage: maximum ${MAX_LIST_SECTIONS} sections allowed`);
  }

  const validatedSections = sections.map((section, si) => {
    if (!Array.isArray(section.rows) || section.rows.length === 0) {
      throw new Error(`buildListMessage: sections[${si}].rows must be a non-empty array`);
    }
    const rows = section.rows.map((row, ri) => {
      if (!row.id || typeof row.id !== 'string') {
        throw new Error(`buildListMessage: sections[${si}].rows[${ri}].id must be a non-empty string`);
      }
      if (!row.title || typeof row.title !== 'string') {
        throw new Error(`buildListMessage: sections[${si}].rows[${ri}].title must be a non-empty string`);
      }
      const entry = {
        id:    row.id,
        title: row.title.slice(0, MAX_LIST_ROW_TITLE_LEN),
      };
      if (row.description) {
        entry.description = String(row.description).slice(0, MAX_LIST_ROW_DESC_LEN);
      }
      return entry;
    });

    return { title: section.title || '', rows };
  });

  const payload = {
    type: 'list',
    body: { text: bodyText },
    action: {
      button: buttonLabel.slice(0, MAX_LIST_BUTTON_LEN),
      sections: validatedSections,
    },
  };

  if (opts.header) payload.header = { type: 'text', text: opts.header };
  if (opts.footer) payload.footer = { text: opts.footer };

  return { type: 'list', payload };
}

/**
 * Parse an incoming WhatsApp interactive webhook event and extract the
 * user's selection.
 *
 * @param {object} message - Raw message object from whatsapp-web.js
 * @returns {{ type: 'button_reply'|'list_reply', id: string, title: string } | null}
 *   Returns null if the message is not an interactive response.
 */
function parseButtonResponse(message) {
  // whatsapp-web.js exposes selectedButtonId / selectedRowId on button messages
  if (message.type === 'buttons_response') {
    return {
      type:  'button_reply',
      id:    message.selectedButtonId || '',
      title: message.body || '',
    };
  }
  if (message.type === 'list_response') {
    return {
      type:  'list_reply',
      id:    message.selectedRowId || '',
      title: message.body || '',
    };
  }
  return null;
}

module.exports = { buildQuickReply, buildListMessage, parseButtonResponse };
