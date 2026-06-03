/**
 * MessagingLayer — abstract base class.
 *
 * All provider implementations (WhatsApp, Telegram, Slack) must extend this
 * and implement all methods. This is the only interface the rest of the system
 * talks to — swapping providers requires no changes elsewhere.
 */
class MessagingLayer {
  constructor() {
    /** @type {function(Message): void|null} */
    this._messageCallback = null;

    /** @type {import('../utils/ExecutionStateManager')|null} */
    this._stateManager = null;
  }

  /**
   * Wire an ExecutionStateManager instance so that every dispatched message is
   * automatically enriched with the current file context (recently mentioned /
   * accessed files) and can carry conversation history to downstream agents.
   *
   * Call this once during app initialisation, after creating the provider:
   *   messagingLayer.setStateManager(stateManager);
   *
   * @param {import('../utils/ExecutionStateManager')} stateManager
   */
  setStateManager(stateManager) {
    this._stateManager = stateManager;
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
   * Send a file document to a user.
   * @param {string} userId - Provider-specific user ID
   * @param {FileAttachment} attachment - File attachment payload
   * @returns {Promise<void>}
   */
  async sendDocument(userId, attachment) {
    throw new Error('sendDocument() not implemented');
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
    // Enrich the message with file context from the state manager so that
    // downstream agents (FileAgent, IntentAgent) can resolve vague file
    // references without needing a separate context lookup.
    if (this._stateManager && !msg.fileContext) {
      msg.fileContext = {
        recentFiles: this._stateManager.getRecentFiles(20),
      };
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
 * @property {FileContext|null} fileContext - Recently mentioned/accessed files from the
 *   conversation; populated automatically by MessagingLayer when a state manager is wired
 *   in via setStateManager().  Passed through to FileAgent so it can resolve vague
 *   references ("this file", "that document") without an extra lookup.
 * @property {string[]} [conversationHistory] - Optional ordered list of recent
 *   conversation turns (e.g. ["user: ...", "assistant: ..."]) for agents that need
 *   broader conversational context.  Populated by callers that track history externally.
 */

/**
 * File context injected into every dispatched Message.
 *
 * @typedef {Object} FileContext
 * @property {Array<{ filePath: string|null, fileName: string|null, mentionedAs: string|null, action: string, timestamp: number }>} recentFiles
 *   - Recently mentioned or accessed files, newest first (up to 20 entries).
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
 * An outgoing file attachment payload for sendDocument().
 *
 * @typedef {Object} FileAttachment
 * @property {string} filePath   - Absolute path to the file on disk
 * @property {string} filename   - Filename to display to the recipient
 * @property {string} mimeType   - MIME type (e.g. 'application/pdf', 'text/plain')
 * @property {number} size       - File size in bytes
 * @property {string|null} caption - Optional caption to accompany the document
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
 * @param {FileContext}        [opts.fileContext]          - Pre-populated file context (optional;
 *   MessagingLayer._dispatchMessage will fill this automatically when a state manager is set)
 * @param {string[]}           [opts.conversationHistory] - Ordered recent conversation turns
 * @returns {Message}
 */
function buildMessage({ userId, text, receivedAt, media, links, buttonInteraction, fileContext, conversationHistory }) {
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
    fileContext: fileContext || null,
    conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
  };
}

module.exports = { MessagingLayer, parseConfirmationCommand, buildMessage };
