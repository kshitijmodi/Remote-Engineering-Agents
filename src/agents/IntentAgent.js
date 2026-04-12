const { ClaudeCodeExecutor } = require('../claude/ClaudeCodeExecutor');

/**
 * IntentAgent
 *
 * Uses a dedicated Claude Haiku call to classify every free-text WhatsApp
 * message into one of four intents:
 *
 *   TASK     — user wants code written, changed, added, fixed, or refactored
 *   QUESTION — user wants information, explanation, or discussion
 *   STATUS   — user is asking about the current task's progress
 *   PUSH     — user wants to commit and push changes to GitHub
 *
 * Uses its own executor so it never eats into the task pipeline budget.
 */
class IntentAgent {
  constructor() {
    // Separate executor with a large budget — never competes with task pipeline
    this._executor = new ClaudeCodeExecutor({ maxInvocations: 10_000, timeoutMs: 30_000 });
  }

  /**
   * Classify a message.
   *
   * @param {string} message
   * @param {object} [opts]
   * @param {string}  [opts.contextBlock]  - Recent conversation history string
   * @param {string}  [opts.activeStatus]  - Current task status, e.g. "coding"
   * @param {boolean} [opts.hasActiveRepo] - Whether the user has a repo connected
   * @param {object}  [opts.multimodal]    - Multimodal context from the message
   * @param {Array}   [opts.multimodal.media] - Attached media (images, PDFs, etc.)
   * @param {Array}   [opts.multimodal.links] - Processed links from the message
   * @returns {Promise<'TASK'|'QUESTION'|'STATUS'|'PUSH'>}
   */
  async classify(message, { contextBlock = '', activeStatus = null, hasActiveRepo = false, multimodal = null } = {}) {
    const situationLines = [
      hasActiveRepo ? 'User has an active repo workspace.' : 'No repo workspace is currently connected.',
      activeStatus ? `There is a task currently running at stage: ${activeStatus}.` : 'No task is currently running.',
      contextBlock ? `Recent conversation:\n${contextBlock}` : '',
    ].filter(Boolean).join('\n');

    // Summarise any attachments so the LLM has richer context for classification
    const attachmentLines = [];
    if (multimodal) {
      const media = multimodal.media;
      const links = multimodal.links;
      if (Array.isArray(media) && media.length > 0) {
        const summary = media.map(m => m.mimeType || m.type || 'file').join(', ');
        attachmentLines.push(`Attachments: ${summary}`);
      }
      if (Array.isArray(links) && links.length > 0) {
        attachmentLines.push(`Links: ${links.map(l => l.url || l).join(', ')}`);
      }
    }

    const prompt = `You are the intent router for a WhatsApp coding bot backed by Claude Code.

Current situation:
${situationLines}

User's message: "${message}"${attachmentLines.length > 0 ? `\n${attachmentLines.join('\n')}` : ''}

Classify the intent. Reply with exactly ONE word — no punctuation, no explanation:
  TASK     — user wants code written, modified, fixed, created, or refactored in the repo
  QUESTION — user wants information, explanation, clarification, or a discussion (not code execution)
  STATUS   — user is checking on the progress of the current running task
  PUSH     — user wants to commit and push the current changes to GitHub

Your reply (one word only):`;

    try {
      const result = await this._executor.run(prompt, process.cwd(), {
        model: 'claude-haiku-4-5-20251001',
      });

      const word = result.output.trim().toUpperCase().split(/[\s\n]+/)[0].replace(/[^A-Z]/g, '');
      if (['TASK', 'QUESTION', 'STATUS', 'PUSH'].includes(word)) return word;
    } catch {
      // Fall through to default
    }

    // Safe default: treat as a question so we answer rather than blindly starting a task
    return 'QUESTION';
  }
}

module.exports = { IntentAgent };
