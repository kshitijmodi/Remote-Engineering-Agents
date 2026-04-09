const { formatStageCompletion } = require('../utils/StatusFormatter');

/**
 * CommunicationAgent
 *
 * Sits between the messaging provider and the rest of the system.
 * Responsibilities:
 *   1. Whitelist authentication — silently drops messages from unknown numbers
 *   2. Slash command parsing — routes /connect, /switch, /resume, /cancel, /logs
 *   3. Natural language task routing — passes free-text to the orchestrator
 *   4. Sending responses back to the user
 *   5. Forwarding orchestrator stageChanged events as formatted WhatsApp updates
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
   * Subscribe to stageChanged events from an OrchestratorAgent instance.
   * Sends a formatted completion summary to the user whenever a pipeline stage finishes.
   * @param {import('./OrchestratorAgent').OrchestratorAgent} orchestrator
   */
  attachOrchestrator(orchestrator) {
    orchestrator.on('stageChanged', ({ userId, previousStage, stageTiming, retries }) => {
      // Only notify for meaningful stage completions (skip queued/failed/cancelled/paused)
      const reportableStages = ['planning', 'coding', 'testing', 'debugging', 'review'];
      if (!reportableStages.includes(previousStage)) return;

      const msg = formatStageCompletion(previousStage, stageTiming);
      this.send(userId, msg).catch((err) => {
        console.error('[CommunicationAgent] Failed to send stageChanged update:', err.message);
      });
    });
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
    console.log(`[CommunicationAgent] Message from ${userId}: "${text.slice(0, 60)}..."`);

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

      case '/repo':
        this._handlers.onRepo?.(userId);
        break;

      case '/clear-context':
        this._handlers.onClearContext?.(userId);
        break;

      case '/list':
        this._handlers.onList?.(userId);
        break;

      case '/restart':
        this._handlers.onRestart?.(userId);
        break;

      case '/stop':
        this._handlers.onStop?.(userId);
        break;

      case '/help':
        await this.send(userId,
          `*Available Commands:*\n\n` +
          `*Workspace*\n` +
          `/init "<local-path>" — set a local folder as active workspace\n` +
          `/connect <repo-url> — clone a GitHub repo and set as active workspace\n` +
          `/switch <repo-name> — switch between registered workspaces\n` +
          `/list — show all registered workspaces\n` +
          `/repo — show currently active workspace\n\n` +
          `*Tasks*\n` +
          `Just type naturally — e.g. "Add a dark mode toggle"\n` +
          `/push [branch-name] — commit and push changes to GitHub\n` +
          `/cancel — cancel the running task\n` +
          `/resume — extend budget by 10 and continue a paused task\n` +
          `/logs — show recent task logs\n\n` +
          `*Bot Control*\n` +
          `/restart — gracefully restart the bot (requires pm2)\n` +
          `/stop — gracefully stop the bot\n\n` +
          `*Other*\n` +
          `/clear-context — reset conversation history for this repo\n` +
          `/help — show this message`
        );
        break;

      default:
        await this.send(userId, `Unknown command: ${command}\nSend /help to see all available commands.`);
    }
  }
}

module.exports = { CommunicationAgent };
