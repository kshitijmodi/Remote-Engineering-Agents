/**
 * CommunicationAgent
 *
 * Sits between the messaging provider and the rest of the system.
 * Responsibilities:
 *   1. Whitelist authentication — silently drops messages from unknown numbers
 *   2. Slash command parsing — routes /connect, /switch, /resume, /cancel, /logs
 *   3. Natural language task routing — passes free-text to the orchestrator
 *   4. Sending responses back to the user
 */
class CommunicationAgent {
  /**
   * @param {import('../messaging/MessagingLayer').MessagingLayer} messagingLayer
   * @param {string[]} allowedNumbers - Whitelisted WhatsApp IDs (e.g. ["447911123456@c.us"])
   * @param {object} handlers - Callbacks for each command type
   * @param {function(string, string): void} handlers.onTask       - (userId, taskText)
   * @param {function(string, string): void} handlers.onConnect    - (userId, repoUrl)
   * @param {function(string, string): void} handlers.onSwitch     - (userId, repoName)
   * @param {function(string): void}         handlers.onResume     - (userId)
   * @param {function(string): void}         handlers.onCancel     - (userId)
   * @param {function(string): void}         handlers.onLogs       - (userId)
   */
  constructor(messagingLayer, allowedNumbers, handlers) {
    this._messaging = messagingLayer;
    this._allowed = new Set(allowedNumbers);
    this._handlers = handlers;
  }

  /**
   * Start listening for messages.
   */
  start() {
    this._messaging.onMessage((msg) => this._handleMessage(msg));
    console.log('[CommunicationAgent] Listening. Whitelist:', [...this._allowed]);
  }

  /**
   * Send a message back to a user.
   * @param {string} userId
   * @param {string} text
   */
  async send(userId, text) {
    await this._messaging.sendMessage(userId, text);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  async _handleMessage(msg) {
    const { userId, text } = msg;

    // 1. Auth — silently ignore unauthorized senders
    if (!this._allowed.has(userId)) return;

    // 2. Parse slash commands
    if (text.startsWith('/')) {
      await this._handleCommand(userId, text);
      return;
    }

    // 3. Natural language — detect status checks, questions, push requests, vs coding tasks
    if (this._isStatusCheck(text)) {
      this._handlers.onStatus?.(userId);
    } else if (this._isQuestion(text)) {
      this._handlers.onQuery?.(userId, text);
    } else if (this._isPushRequest(text)) {
      this._handlers.onPush?.(userId, null);
    } else {
      this._handlers.onTask?.(userId, text);
    }
  }

  _isStatusCheck(text) {
    const t = text.trim().toLowerCase().replace(/[?!.]/g, '');
    return ['done', 'status', 'are you done', 'is it done', 'finished', 'complete',
            'any update', 'update', 'progress', 'whats happening', "what's happening",
            'still running', 'how long'].includes(t);
  }

  _isQuestion(text) {
    const t = text.trim().toLowerCase();
    return /^(what|who|where|when|why|how|tell me|explain|describe|summarize|show me|list|can you|could you|is |are |does |do )/.test(t)
      || t.endsWith('?');
  }

  _isPushRequest(text) {
    const t = text.trim().toLowerCase();
    // Only match if the message is primarily about pushing — short and direct.
    // Avoid matching task descriptions that happen to mention "push to github" at the end.
    const isShort = t.split(' ').length <= 8;
    const hasPushIntent = /^(push|send|upload|deploy|sync)/.test(t) || t === 'push to github' || t === '/push';
    return isShort && hasPushIntent;
  }

  async _handleCommand(userId, text) {
    const [command, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();

    switch (command.toLowerCase()) {
      case '/init':
        if (!arg) {
          await this.send(userId, 'Usage: /init <local-folder-path> [repo-name]');
          return;
        }
        this._handlers.onInit?.(userId, arg);
        break;

      case '/connect':
        if (!arg) {
          await this.send(userId, 'Usage: /connect <repo-url>');
          return;
        }
        this._handlers.onConnect?.(userId, arg);
        break;

      case '/switch':
        if (!arg) {
          await this.send(userId, 'Usage: /switch <repo-name>');
          return;
        }
        this._handlers.onSwitch?.(userId, arg);
        break;

      case '/resume':
        this._handlers.onResume?.(userId);
        break;

      case '/cancel':
        this._handlers.onCancel?.(userId);
        break;

      case '/logs':
        this._handlers.onLogs?.(userId);
        break;

      case '/push':
        this._handlers.onPush?.(userId, arg);
        break;

      default:
        await this.send(userId, `Unknown command: ${command}\nAvailable: /init, /connect, /switch, /push, /resume, /cancel, /logs`);
    }
  }
}

module.exports = { CommunicationAgent };
