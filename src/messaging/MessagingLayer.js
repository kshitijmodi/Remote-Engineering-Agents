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
 */

module.exports = { MessagingLayer };
