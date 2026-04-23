const { ButtonResponseHandler } = require('./ButtonResponseHandler');

/**
 * MessagingLayer — abstract base class.
 *
 * All provider implementations (WhatsApp, Telegram, Slack) must extend this
 * and implement all methods. This is the only interface the rest of the system
 * talks to — swapping providers requires no changes elsewhere.
 */
class MessagingLayer {
  constructor() {
    /** @type {ButtonResponseHandler|null} */
    this._buttonResponseHandler = null;

    /** @type {function(Message): void|null} */
    this._messageCallback = null;
  }

  /**
   * Connect to the messaging provider and start listening.
   * Should emit 'ready' when connected.
   * @returns {Promise<void>}
   */
  async connect() {
    throw new Error('connect() not implemented');
  }

  /**
   * Disconnect gracefully.
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('disconnect() not implemented');
  }

  /**
   * Register a callback for incoming messages.
   * Callback receives a normalized Message object.
   * @param {function(Message): void} callback
   */
  onMessage(callback) {
    throw new Error('onMessage() not implemented');
  }

  /**
   * Register a ButtonResponseHandler to intercept button interactions before
   * they reach the normal text message callback. When a message arrives with
   * a buttonInteraction field and the handler recognises the button ID, the
   * message is consumed and the text callback is NOT called.
   *
   * @param {ButtonResponseHandler} handler
   */
  registerButtonResponseHandler(handler) {
    if (!(handler instanceof ButtonResponseHandler)) {
      throw new TypeError('handler must be an instance of ButtonResponseHandler');
    }
    this._buttonResponseHandler = handler;
  }

  /**
   * Send a message to a user.
   * @param {string} userId - Provider-specific user ID
   * @param {string} text
   * @returns {Promise<void>}
   */
  async sendMessage(userId, text) {
    throw new Error('sendMessage() not implemented');
  }

  /**
   * Send a quick-reply button message.
   * @param {string} userId
   * @param {string} bodyText - The message body shown above the buttons
   * @param {Array<{ id: string, title: string }>} buttons - Up to 3 buttons
   * @returns {Promise<void>}
   */
  async sendQuickReply(userId, bodyText, buttons) {
    throw new Error('sendQuickReply() not implemented');
  }

  /**
   * Send a list/menu message with selectable rows.
   * @param {string} userId
   * @param {string} bodyText        - The message body
   * @param {string} buttonLabel     - Label shown on the list-open button
   * @param {Array<{ id: string, title: string, description?: string }>} rows
   * @returns {Promise<void>}
   */
  async sendListMessage(userId, bodyText, buttonLabel, rows) {
    throw new Error('sendListMessage() not implemented');
  }

  /**
   * Returns the current connection status.
   * @returns {{ connected: boolean, provider: string, detail?: string }}
   */
  getStatus() {
    throw new Error('getStatus() not implemented');
  }

  /**
   * Dispatch a normalized message through the button-interaction pipeline
   * before handing off to the registered text callback.
   *
   * Subclasses should call this instead of invoking the text callback directly
   * so that button interactions are intercepted automatically.
   *
   * Flow:
   *   1. If the message has a buttonInteraction and a ButtonResponseHandler is
   *      registered, attempt to route via the handler.
   *   2. If the handler consumed the interaction (returns true), stop — do not
   *      call the text callback.
   *   3. Otherwise fall through to the normal text callback.
   *
   * @param {Message} msg - Normalized message from buildMessage()
   */
  _dispatchMessage(msg) {
    if (msg.buttonInteraction && this._buttonResponseHandler) {
      const handled = this._buttonResponseHandler.handleMessage(msg);
      if (handled) return;
    }

    if (typeof this._messageCallback === 'function') {
      this._messageCallback(msg);
    }
  }
}

/**
 * Normalized message structure — same shape regardless of provider.
 *
 * @typedef {Object} Message
 * @property {string} userId   - Unique ID for this user (e.g. WhatsApp number)
 * @property {string} text     - Raw message text
 * @property {Date}   receivedAt
 * @property {boolean} isConfirmation  - true if text is a /confirm or /cancel command
 * @property {string|null} confirmationAction  - 'confirm' | 'cancel' | null
 * @property {MediaAttachment[]} media - Array of media attachments (images, PDFs, etc.)
 * @property {LinkObject[]} links      - Array of extracted URLs from message text
 * @property {ButtonInteraction|null} buttonInteraction - Set when the message is a button
 *   response (quick reply or list selection); null for normal text messages.
 */

/**
 * A button interaction parsed from an incoming WhatsApp interactive message.
 *
 * @typedef {Object} ButtonInteraction
 * @property {'quick_reply'|'list'} type - The WhatsApp interactive message type
 * @property {string|null} buttonId  - Button ID for quick_reply interactions
 * @property {string|null} rowId     - Row ID for list interactions
 * @property {string|null} title     - Human-readable label of the selected button/row
 */

/**
 * A media attachment extracted from an incoming message.
 *
 * @typedef {Object} MediaAttachment
 * @property {string} type       - MIME type (e.g. 'image/jpeg', 'application/pdf')
 * @property {string} url        - Provider-supplied download URL for the media
 * @property {string|null} caption - Optional caption accompanying the media
 * @property {string|null} filename - Original filename, if available
 * @property {number|null} size  - File size in bytes, if available
 */

/**
 * A URL extracted from message text or a shared link preview.
 *
 * @typedef {Object} LinkObject
 * @property {string} url        - The raw URL string
 * @property {string|null} title - Page title from link preview, if available
 * @property {string|null} description - Short description from link preview, if available
 */

/**
 * Parses a raw message text and returns confirmation metadata.
 * Recognized commands (case-insensitive, leading slash):
 *   /confirm  — user approves the proposed plan
 *   /cancel   — user rejects the proposed plan
 *
 * @param {string} text
 * @returns {{ isConfirmation: boolean, confirmationAction: string|null }}
 */
function parseConfirmationCommand(text) {
  if (typeof text !== 'string') {
    return { isConfirmation: false, confirmationAction: null };
  }

  const trimmed = text.trim().toLowerCase();

  if (trimmed === '/confirm') {
    return { isConfirmation: true, confirmationAction: 'confirm' };
  }

  if (trimmed === '/cancel') {
    return { isConfirmation: true, confirmationAction: 'cancel' };
  }

  return { isConfirmation: false, confirmationAction: null };
}

/**
 * Builds a normalized Message object with all required fields, including the
 * new multimodal fields. Providers should call this instead of constructing
 * the object ad-hoc to ensure the shape stays consistent.
 *
 * @param {object} opts
 * @param {string}  opts.userId
 * @param {string}  opts.text
 * @param {Date}    [opts.receivedAt]
 * @param {MediaAttachment[]}  [opts.media]
 * @param {LinkObject[]}       [opts.links]
 * @param {ButtonInteraction}  [opts.buttonInteraction]
 * @returns {Message}
 */
function buildMessage({ userId, text, receivedAt, media, links, buttonInteraction }) {
  const { isConfirmation, confirmationAction } = parseConfirmationCommand(text);
  return {
    userId,
    text,
    receivedAt: receivedAt || new Date(),
    isConfirmation,
    confirmationAction,
    media: Array.isArray(media) ? media : [],
    links: Array.isArray(links) ? links : [],
    buttonInteraction: buttonInteraction || null,
  };
}

module.exports = { MessagingLayer, parseConfirmationCommand, buildMessage, ButtonResponseHandler };
