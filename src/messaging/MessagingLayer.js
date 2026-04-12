/**
 * MessagingLayer — abstract base class.
 *
 * All provider implementations (WhatsApp, Telegram, Slack) must extend this
 * and implement all methods. This is the only interface the rest of the system
 * talks to — swapping providers requires no changes elsewhere.
 */
class MessagingLayer {
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
   * Send a message to a user.
   * @param {string} userId - Provider-specific user ID
   * @param {string} text
   * @returns {Promise<void>}
   */
  async sendMessage(userId, text) {
    throw new Error('sendMessage() not implemented');
  }

  /**
   * Returns the current connection status.
   * @returns {{ connected: boolean, provider: string, detail?: string }}
   */
  getStatus() {
    throw new Error('getStatus() not implemented');
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
 * @param {MediaAttachment[]} [opts.media]
 * @param {LinkObject[]}      [opts.links]
 * @returns {Message}
 */
function buildMessage({ userId, text, receivedAt, media, links }) {
  const { isConfirmation, confirmationAction } = parseConfirmationCommand(text);
  return {
    userId,
    text,
    receivedAt: receivedAt || new Date(),
    isConfirmation,
    confirmationAction,
    media: Array.isArray(media) ? media : [],
    links: Array.isArray(links) ? links : [],
  };
}

module.exports = { MessagingLayer, parseConfirmationCommand, buildMessage };
