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
const MAX_QUICK_REPLY_BUTTONS    = 3;
const MAX_BUTTON_TITLE_LEN       = 20;
const MAX_LIST_SECTIONS          = 10;
const MAX_LIST_ROW_TITLE_LEN     = 24;
const MAX_LIST_ROW_DESC_LEN      = 72;
const MAX_LIST_BUTTON_LEN        = 20;
const MAX_TEMPLATE_BUTTONS       = 3;   // max quick-reply buttons per template
const MAX_TEMPLATE_PAYLOAD_LEN   = 128; // max payload string length per template button
const MAX_TEMPLATE_PARAM_LEN     = 1024;

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
 * Build a Template message payload for approval workflows.
 *
 * Template messages are pre-approved by WhatsApp/Meta and can be sent
 * outside the 24-hour messaging window, making them suitable for
 * business-initiated approval requests.
 *
 * @param {string} templateName  - Approved template name (snake_case, e.g. "plan_approval").
 * @param {string} languageCode  - BCP-47 language code (e.g. "en_US").
 * @param {object} [opts]
 * @param {Array<string>} [opts.bodyParams]
 *   Ordered list of parameter strings to substitute into the template body
 *   ({{1}}, {{2}}, …).
 * @param {string} [opts.headerParam]
 *   A single text parameter for a template header containing {{1}}.
 * @param {Array<{payload: string, index?: number}>} [opts.buttons]
 *   Quick-reply button overrides. Each entry:
 *     payload — the string sent back in the webhook when the user taps the button
 *               (max 128 chars). Acts as the button ID for handler routing.
 *     index   — 0-based position matching the button slot in the approved template
 *               (defaults to array position if omitted).
 *   Maximum 3 quick-reply buttons.
 * @returns {{ type: 'template', payload: object }}
 *
 * @example
 * // Approval workflow: "plan_approval" template has body "Review your plan: {{1}}"
 * // and two quick-reply buttons at index 0 ("Approve") and index 1 ("Cancel").
 * buildTemplateMessage('plan_approval', 'en_US', {
 *   bodyParams: ['Deploy to production'],
 *   buttons: [
 *     { payload: 'action:confirm:plan', index: 0 },
 *     { payload: 'action:cancel:plan',  index: 1 },
 *   ],
 * });
 */
function buildTemplateMessage(templateName, languageCode, opts = {}) {
  if (!templateName || typeof templateName !== 'string') {
    throw new Error('buildTemplateMessage: templateName must be a non-empty string');
  }
  if (!languageCode || typeof languageCode !== 'string') {
    throw new Error('buildTemplateMessage: languageCode must be a non-empty string');
  }

  const components = [];

  // Header component (optional single text parameter)
  if (opts.headerParam !== undefined) {
    const param = String(opts.headerParam).slice(0, MAX_TEMPLATE_PARAM_LEN);
    components.push({
      type:       'header',
      parameters: [{ type: 'text', text: param }],
    });
  }

  // Body component (optional ordered positional parameters)
  if (Array.isArray(opts.bodyParams) && opts.bodyParams.length > 0) {
    components.push({
      type:       'body',
      parameters: opts.bodyParams.map(p => ({
        type: 'text',
        text: String(p).slice(0, MAX_TEMPLATE_PARAM_LEN),
      })),
    });
  }

  // Button components (quick-reply payload overrides)
  if (Array.isArray(opts.buttons) && opts.buttons.length > 0) {
    if (opts.buttons.length > MAX_TEMPLATE_BUTTONS) {
      throw new Error(`buildTemplateMessage: maximum ${MAX_TEMPLATE_BUTTONS} buttons allowed`);
    }
    opts.buttons.forEach((btn, i) => {
      if (!btn.payload || typeof btn.payload !== 'string') {
        throw new Error(`buildTemplateMessage: buttons[${i}].payload must be a non-empty string`);
      }
      const buttonIndex = btn.index !== undefined ? btn.index : i;
      components.push({
        type:       'button',
        sub_type:   'quick_reply',
        index:      String(buttonIndex),
        parameters: [{
          type:    'payload',
          payload: btn.payload.slice(0, MAX_TEMPLATE_PAYLOAD_LEN),
        }],
      });
    });
  }

  const payload = {
    type: 'template',
    template: {
      name:     templateName,
      language: { code: languageCode },
      ...(components.length > 0 && { components }),
    },
  };

  return { type: 'template', payload };
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
  // Template quick-reply buttons arrive as interactive messages with
  // button_reply sub-type; the payload field carries the string set in
  // buildTemplateMessage's buttons[].payload.
  if (
    message.type === 'interactive' &&
    message.interactive?.type === 'button_reply'
  ) {
    const reply = message.interactive.button_reply;
    return {
      type:  'template_button_reply',
      id:    reply?.payload || reply?.id || '',
      title: reply?.title || '',
    };
  }
  return null;
}

module.exports = { buildQuickReply, buildListMessage, buildTemplateMessage, parseButtonResponse };
