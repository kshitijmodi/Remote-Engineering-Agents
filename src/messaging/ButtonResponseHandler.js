/**
 * ButtonResponseHandler — processes incoming WhatsApp button interactions
 * and routes them to the appropriate agent handlers.
 *
 * Button ID conventions (defined in src/ui/ConfirmationPrompts.js):
 *   confirm_yes / confirm_no          — yesNo() prompts
 *   ccm_confirm / ccm_cancel          — confirmCancel() prompts
 *   ccm_confirm / ccm_cancel / ccm_modify — confirmCancelModify() prompts
 *   choice_<index>                     — choiceList() prompts
 *   retry_retry / retry_cancel         — retryCancel() prompts
 *
 * Usage:
 *   const handler = new ButtonResponseHandler(handlers);
 *   // In message pipeline, after WhatsAppProvider attaches buttonInteraction:
 *   if (msg.buttonInteraction) {
 *     const handled = handler.handle(msg.userId, msg.buttonInteraction);
 *     if (handled) return; // do not pass to normal text routing
 *   }
 */

class ButtonResponseHandler {
  /**
   * @param {object} handlers - Callbacks mirroring CommunicationAgent's handler signatures.
   * @param {function(string): void}         [handlers.onConfirm]  - (userId) user approved
   * @param {function(string): void}         [handlers.onCancel]   - (userId) user cancelled
   * @param {function(string, string): void} [handlers.onModify]   - (userId, hint) user wants modifications
   *   hint is the button title when available, otherwise an empty string.
   * @param {function(string): void}         [handlers.onYes]      - (userId) affirmative on yesNo prompt
   *   Falls back to onConfirm when not provided.
   * @param {function(string): void}         [handlers.onNo]       - (userId) negative on yesNo prompt
   *   Falls back to onCancel when not provided.
   * @param {function(string, number, string): void} [handlers.onChoice]
   *   (userId, choiceIndex, choiceTitle) — row selected from a choiceList prompt
   * @param {function(string): void}         [handlers.onRetry]    - (userId) retry after failure prompt
   */
  constructor(handlers = {}) {
    this._handlers = handlers;
  }

  /**
   * Process a button interaction attached to a normalized message.
   *
   * @param {string} userId
   * @param {{ type: 'quick_reply'|'list', buttonId?: string, rowId?: string, title?: string }} interaction
   *   The buttonInteraction object set by WhatsAppProvider on the normalized message.
   * @returns {boolean} true if the interaction was recognised and routed; false otherwise.
   */
  handle(userId, interaction) {
    if (!interaction) return false;

    // Resolve the canonical ID regardless of interaction type
    const id    = interaction.buttonId || interaction.rowId || '';
    const title = interaction.title || '';

    return this._route(userId, id, title);
  }

  /**
   * Convenience wrapper — accepts a full normalized message object and checks
   * whether it carries a button interaction before attempting to route.
   *
   * @param {{ userId: string, buttonInteraction?: object }} msg
   * @returns {boolean} true if a button interaction was found and routed.
   */
  handleMessage(msg) {
    if (!msg || !msg.buttonInteraction) return false;
    return this.handle(msg.userId, msg.buttonInteraction);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _route(userId, id, title) {
    const h = this._handlers;

    // ── Confirm / Cancel / Modify (confirmCancelModify & confirmCancel) ───────
    if (id === 'ccm_confirm') {
      this._invoke(h.onConfirm, userId);
      return true;
    }

    if (id === 'ccm_cancel') {
      this._invoke(h.onCancel, userId);
      return true;
    }

    if (id === 'ccm_modify') {
      // Pass the button title as a hint so the modify handler can optionally
      // use it for context. The real modification text still comes from the
      // user's next free-text message in practice.
      if (typeof h.onModify === 'function') {
        h.onModify(userId, title);
      } else {
        // No dedicated modify handler — treat as cancel with a log warning
        console.warn('[ButtonResponseHandler] ccm_modify received but no onModify handler registered.');
      }
      return true;
    }

    // ── Yes / No (yesNo) ─────────────────────────────────────────────────────
    if (id === 'confirm_yes') {
      // Prefer a dedicated yes handler; fall back to confirm
      if (typeof h.onYes === 'function') {
        h.onYes(userId);
      } else {
        this._invoke(h.onConfirm, userId);
      }
      return true;
    }

    if (id === 'confirm_no') {
      // Prefer a dedicated no handler; fall back to cancel
      if (typeof h.onNo === 'function') {
        h.onNo(userId);
      } else {
        this._invoke(h.onCancel, userId);
      }
      return true;
    }

    // ── Retry / Cancel (retryCancel) ─────────────────────────────────────────
    if (id === 'retry_retry') {
      if (typeof h.onRetry === 'function') {
        h.onRetry(userId);
      } else {
        console.warn('[ButtonResponseHandler] retry_retry received but no onRetry handler registered.');
      }
      return true;
    }

    if (id === 'retry_cancel') {
      this._invoke(h.onCancel, userId);
      return true;
    }

    // ── Generic choice (choiceList) ───────────────────────────────────────────
    const choiceMatch = id.match(/^choice_(\d+)$/);
    if (choiceMatch) {
      const index = parseInt(choiceMatch[1], 10);
      if (typeof h.onChoice === 'function') {
        h.onChoice(userId, index, title);
      } else {
        console.warn(`[ButtonResponseHandler] choice_${index} received but no onChoice handler registered.`);
      }
      return true;
    }

    // ── Unknown button ID ─────────────────────────────────────────────────────
    console.warn(`[ButtonResponseHandler] Unrecognised button ID: "${id}" (title: "${title}")`);
    return false;
  }

  /**
   * Safely invoke a handler if it exists.
   * @param {function|undefined} fn
   * @param {string} userId
   */
  _invoke(fn, userId) {
    if (typeof fn === 'function') {
      fn(userId);
    }
  }
}

module.exports = { ButtonResponseHandler };
