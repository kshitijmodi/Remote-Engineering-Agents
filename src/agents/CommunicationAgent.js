const {
  formatStageCompletion,
  formatPlan,
  formatStepProgress,
  formatCompletionRecap,
} = require('../utils/StatusFormatter');
const { MessageMedia } = require('whatsapp-web.js');
const {
  confirmCancelModify,
  confirmCancel,
  yesNo,
  retryCancel,
  choiceList,
} = require('../ui/ConfirmationPrompts');
const { ButtonResponseHandler } = require('../messaging/ButtonResponseHandler');

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

    // Wire button interactions to the appropriate action handlers
    this._buttonHandler = new ButtonResponseHandler({
      onConfirm: (userId) => this._handlers.onConfirm?.(userId),
      onCancel:  (userId) => this._handlers.onCancel?.(userId),
      onModify:  (userId, hint) => this._handlers.onModify?.(userId, hint),
      onChoice:  (userId, index, title) => this._handlers.onChoice?.(userId, index, title),
      onYes:     (userId) => (this._handlers.onYes ?? this._handlers.onConfirm)?.(userId),
      onNo:      (userId) => (this._handlers.onNo  ?? this._handlers.onCancel)?.(userId),
      onRetry:   (userId) => this._handlers.onRetry?.(userId),
    });
  }

  /**
   * Start listening for messages.
   */
  start() {
    this._messaging.onMessage((msg) => {
      this._handleMessage(msg).catch((err) => {
        console.error('[CommunicationAgent] Unhandled error in message handler:', err.message);
      });
    });
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
   * Send a media attachment back to a user (image or PDF).
   * Falls back to a descriptive text caption if the provider does not support
   * raw media sending.
   *
   * @param {string} userId
   * @param {{ mimeType: string, data: string, filename?: string|null, caption?: string|null }} mediaItem
   *   - data: base64-encoded content
   */
  async sendMedia(userId, mediaItem) {
    const { mimeType, data, filename, caption } = mediaItem;

    // Prefer native media sending when the messaging provider exposes it
    if (typeof this._messaging.sendMediaMessage === 'function') {
      await this._messaging.sendMediaMessage(userId, mediaItem);
      return;
    }

    // whatsapp-web.js path — build a MessageMedia and send it directly via
    // the underlying client if it is accessible on the provider.
    const client = this._messaging._client;
    if (client && typeof client.sendMessage === 'function' && data) {
      try {
        const media = new MessageMedia(mimeType, data, filename || null);
        await client.sendMessage(userId, media, caption ? { caption } : {});
        return;
      } catch (err) {
        console.warn('[CommunicationAgent] sendMedia via _client failed:', err.message);
      }
    }

    // Last-resort: send a text description so the user knows media was processed
    const label = filename ? `"${filename}"` : mimeType;
    await this.send(userId, `[Media: ${label}]${caption ? ` — ${caption}` : ''}`);
  }

  /**
   * Send a response that may contain both text and media items.
   * Text is sent first; each media attachment is sent as a separate message.
   *
   * @param {string} userId
   * @param {string} text          - Text portion of the response (may be empty)
   * @param {Array<object>} [mediaItems] - Optional array of media items to send
   */
  async sendMultimodalResponse(userId, text, mediaItems = []) {
    if (text && text.trim()) {
      await this.send(userId, text);
    }

    for (const item of mediaItems) {
      try {
        await this.sendMedia(userId, item);
      } catch (err) {
        console.error('[CommunicationAgent] Failed to send media item:', err.message);
        // Continue sending remaining items even if one fails
      }
    }
  }

  /**
   * Send a plan confirmation prompt to the user.
   * Uses interactive buttons (Confirm / Cancel / Modify) when the provider supports
   * them; falls back to the plain-text /confirm | /cancel | /modify prompt otherwise.
   * @param {string} userId
   * @param {Array<{id: number, description: string}>} steps
   */
  async sendPlanConfirmation(userId, steps) {
    const stepList = steps.map((s) => `${s.id}. ${s.description}`).join('\n');
    const bodyText = `📋 *Implementation Plan* (${steps.length} steps):\n${stepList}`;

    const prompt = confirmCancelModify(bodyText, {
      header: 'Ready to execute?',
      footer: 'You can also type /confirm, /cancel, or /modify <changes>',
    });

    await this._sendButtonPrompt(userId, prompt).catch((err) => {
      console.error('[CommunicationAgent] Failed to send plan confirmation:', err.message);
    });
  }

  /**
   * Send a yes/no button prompt to the user.
   * Falls back to plain text if the provider does not support buttons.
   * @param {string} userId
   * @param {string} question
   * @param {object} [opts]   - Forwarded to ConfirmationPrompts.yesNo()
   */
  async sendYesNoPrompt(userId, question, opts = {}) {
    const prompt = yesNo(question, opts);
    await this._sendButtonPrompt(userId, prompt).catch((err) => {
      console.error('[CommunicationAgent] Failed to send yes/no prompt:', err.message);
    });
  }

  /**
   * Send a retry/cancel button prompt to the user after a failure.
   * Falls back to plain text if the provider does not support buttons.
   * @param {string} userId
   * @param {string} bodyText - Description of what failed.
   * @param {object} [opts]   - Forwarded to ConfirmationPrompts.retryCancel()
   */
  async sendRetryCancelPrompt(userId, bodyText, opts = {}) {
    const prompt = retryCancel(bodyText, opts);
    await this._sendButtonPrompt(userId, prompt).catch((err) => {
      console.error('[CommunicationAgent] Failed to send retry/cancel prompt:', err.message);
    });
  }

  /**
   * Send a confirm/cancel button prompt to the user (two-option variant, no modify).
   * Falls back to plain text if the provider does not support buttons.
   * @param {string} userId
   * @param {string} bodyText - Summary of the pending action.
   * @param {object} [opts]   - Forwarded to ConfirmationPrompts.confirmCancel()
   */
  async sendConfirmCancelPrompt(userId, bodyText, opts = {}) {
    const prompt = confirmCancel(bodyText, opts);
    await this._sendButtonPrompt(userId, prompt).catch((err) => {
      console.error('[CommunicationAgent] Failed to send confirm/cancel prompt:', err.message);
    });
  }

  /**
   * Send a generic choice list to the user.
   * Falls back to plain text if the provider does not support list messages.
   * @param {string} userId
   * @param {string} question   - The question / instruction shown in the body.
   * @param {string[]} choices  - Array of choice labels (max 10).
   * @param {object} [opts]     - Forwarded to ConfirmationPrompts.choiceList()
   */
  async sendChoicePrompt(userId, question, choices, opts = {}) {
    const prompt = choiceList(question, choices, opts);
    await this._sendButtonPrompt(userId, prompt).catch((err) => {
      console.error('[CommunicationAgent] Failed to send choice prompt:', err.message);
    });
  }

  /**
   * Internal helper: dispatch a structured button prompt to the messaging layer.
   * Tries provider-specific button methods; falls back to plain text if unavailable.
   * @param {string} userId
   * @param {{ type: 'quick_reply'|'list', payload: object }} prompt
   */
  async _sendButtonPrompt(userId, prompt) {
    if (prompt.type === 'quick_reply' && typeof this._messaging.sendQuickReply === 'function') {
      await this._messaging.sendQuickReply(userId, prompt.payload);
      return;
    }
    if (prompt.type === 'list' && typeof this._messaging.sendListMessage === 'function') {
      await this._messaging.sendListMessage(userId, prompt.payload);
      return;
    }
    // Fallback: flatten the prompt to plain text
    const { body, buttons, sections } = prompt.payload;
    let text = body || '';
    if (buttons && buttons.length) {
      text += '\n\n' + buttons.map((b) => `• ${b.title}`).join('\n');
    } else if (sections && sections.length) {
      for (const section of sections) {
        if (section.title) text += `\n\n*${section.title}*`;
        for (const row of section.rows || []) {
          text += `\n• ${row.title}`;
        }
      }
    }
    await this._messaging.sendMessage(userId, text.trim());
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
    const { userId, text, media = [], urls = [], links = [] } = msg;

    // 1. Auth — silently ignore unauthorized senders
    if (!this._allowed.has(userId)) return;

    // Merge urls (WhatsApp raw) and links (normalised MessagingLayer objects)
    const allUrls = [...urls, ...links.map((l) => (typeof l === 'string' ? l : l.url)).filter(Boolean)];

    const mediaCount = media.length;
    const urlCount = allUrls.length;
    const multimodalSuffix = [
      mediaCount ? `${mediaCount} media` : '',
      urlCount ? `${urlCount} URL(s)` : '',
    ].filter(Boolean).join(', ');

    console.log(
      `[CommunicationAgent] Message from ${userId}: "${(text || '').slice(0, 60)}"` +
      (multimodalSuffix ? ` [+${multimodalSuffix}]` : '')
    );

    // 2. Intercept button interactions before any text routing
    if (this._buttonHandler.handleMessage(msg)) return;

    // 3. Parse slash commands
    if (text && text.startsWith('/')) {
      await this._handleCommand(userId, text);
      return;
    }

    // 4. If the message carries only media with no text, synthesize a placeholder
    //    so intent classification still works and handlers receive something useful.
    const effectiveText = text || (mediaCount ? '[media attachment]' : '');

    // 5. Natural language — classify intent with LLM (or fall back to heuristic)
    let intent;
    if (this._classify) {
      try {
        intent = await this._classify(userId, effectiveText);
      } catch {
        intent = 'TASK'; // safe fallback on classifier error
      }
    } else {
      intent = this._heuristicClassify(effectiveText);
    }

    // Multimodal context object forwarded to all handlers that accept it
    const multimodal = { media, urls: allUrls };

    const dispatch = (() => {
      switch (intent) {
        case 'STATUS':   return this._handlers.onStatus?.(userId);
        case 'QUESTION': return this._handlers.onQuery?.(userId, effectiveText, multimodal);
        case 'PUSH':     return this._handlers.onPush?.(userId, null);
        default:         return this._handlers.onTask?.(userId, effectiveText, multimodal);
      }
    })();
    Promise.resolve(dispatch).catch((err) => {
      console.error(`[CommunicationAgent] Handler error (intent=${intent}):`, err.message);
    });
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
