const {
  formatStageCompletion,
  formatPlan,
  formatStepProgress,
  formatCompletionRecap,
} = require('../utils/StatusFormatter');

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
   * @param {function(string): void}         handlers.onConfirm    - (userId)
   * @param {function(string, string): void} handlers.onModify     - (userId, modificationText)
   * @param {function(string, string): Promise<string>} [classify] - Optional async intent classifier
   *        Signature: (userId, text) => Promise<'TASK'|'QUESTION'|'STATUS'|'PUSH'>
   */
  constructor(messagingLayer, allowedNumbers, handlers, classify = null) {
    this._messaging = messagingLayer;
    this._allowed = new Set(allowedNumbers);
    this._handlers = handlers;
    this._classify = classify;
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

  /**
   * Send a plan confirmation prompt to the user.
   * Formats the plan steps and asks the user to /confirm, /cancel, or /modify.
   * @param {string} userId
   * @param {Array<{id: number, description: string}>} steps
   */
  async sendPlanConfirmation(userId, steps) {
    const msg = formatPlan(steps);
    await this.send(userId, msg).catch((err) => {
      console.error('[CommunicationAgent] Failed to send plan confirmation:', err.message);
    });
  }

  /**
   * Send a step progress update to the user.
   * @param {string} userId
   * @param {{id: number, description: string}} step - the step that just completed
   * @param {number} totalSteps
   */
  async sendProgressUpdate(userId, step, totalSteps) {
    const msg = formatStepProgress(step, totalSteps);
    await this.send(userId, msg).catch((err) => {
      console.error('[CommunicationAgent] Failed to send progress update:', err.message);
    });
  }

  /**
   * Send a final task completion recap to the user.
   * @param {string} userId
   * @param {object} task          - task object with planSteps and stageTiming
   * @param {object} [reviewResult]
   * @param {object} [prResult]
   */
  async sendFinalConfirmation(userId, task, reviewResult, prResult) {
    const msg = formatCompletionRecap(task, reviewResult, prResult);
    await this.send(userId, msg).catch((err) => {
      console.error('[CommunicationAgent] Failed to send final confirmation:', err.message);
    });
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

    // 3. Natural language — classify intent with LLM (or fall back to heuristic)
    let intent;
    if (this._classify) {
      try {
        intent = await this._classify(userId, text);
      } catch {
        intent = 'TASK'; // safe fallback on classifier error
      }
    } else {
      intent = this._heuristicClassify(text);
    }

    switch (intent) {
      case 'STATUS':   this._handlers.onStatus?.(userId);        break;
      case 'QUESTION': this._handlers.onQuery?.(userId, text);   break;
      case 'PUSH':     this._handlers.onPush?.(userId, null);    break;
      default:         this._handlers.onTask?.(userId, text);
    }
  }

  // Fallback heuristic used only when no LLM classifier is provided
  _heuristicClassify(text) {
    const t = text.trim().toLowerCase().replace(/[?!.]/g, '');
    const statusPhrases = ['done', 'status', 'are you done', 'is it done', 'finished', 'complete',
      'any update', 'update', 'progress', 'whats happening', "what's happening", 'still running', 'how long'];
    if (statusPhrases.includes(t)) return 'STATUS';

    const orig = text.trim().toLowerCase();
    if (/^(what|who|where|when|why|how|tell me|explain|describe|summarize|show me|list|can you|could you|is |are |does |do )/.test(orig)
      || orig.endsWith('?')) return 'QUESTION';

    const words = orig.split(' ');
    if (words.length <= 8 && (/^(push|send|upload|deploy|sync)/.test(orig) || orig === 'push to github')) return 'PUSH';

    return 'TASK';
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

      case '/confirm':
        this._handlers.onConfirm?.(userId);
        break;

      case '/modify':
        if (!arg) {
          await this.send(userId, 'Usage: /modify <description of changes to the plan>');
          return;
        }
        this._handlers.onModify?.(userId, arg);
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
          `/confirm — approve the plan and start execution\n` +
          `/modify <changes> — revise the plan before confirming\n` +
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
