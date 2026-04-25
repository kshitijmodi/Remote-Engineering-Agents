const { ClaudeCodeExecutor } = require('../claude/ClaudeCodeExecutor');
const { extractFileHint } = require('../utils/FileMatching');

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
   * @returns {Promise<'TASK'|'QUESTION'|'STATUS'|'PUSH'|'FILE_SEND'>}
   */
  async classify(message, { contextBlock = '', activeStatus = null, hasActiveRepo = false, multimodal = null } = {}) {
    // Fast path: detect file-send intent without burning an LLM call.
    // Covers explicit paths, vague demonstratives ("this file", "that doc"),
    // type-only references ("send the pdf"), and verb+pronoun combos ("send that").
    if (this._isFileSendIntent(message)) {
      return 'FILE_SEND';
    }
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
  TASK      — user wants code written, modified, fixed, created, or refactored in the repo
  QUESTION  — user wants information, explanation, clarification, or a discussion (not code execution)
  STATUS    — user is checking on the progress of the current running task
  PUSH      — user wants to commit and push the current changes to GitHub
  FILE_SEND — user wants to receive a file, document, attachment, or log from the filesystem
              (includes vague references like "send me this", "share that document", "give me the pdf",
               "forward me the report", "can you send that file", "i need that script", "show me the log")

Your reply (one word only):`;

    try {
      const result = await this._executor.run(prompt, process.cwd(), {
        model: 'claude-haiku-4-5-20251001',
      });

      const word = result.output.trim().toUpperCase().split(/[\s\n]+/)[0].replace(/[^A-Z_]/g, '');
      if (['TASK', 'QUESTION', 'STATUS', 'PUSH', 'FILE_SEND'].includes(word)) return word;
    } catch {
      // Fall through to default
    }

    // Safe default: treat as a question so we answer rather than blindly starting a task
    return 'QUESTION';
  }

  /**
   * Extract a file reference hint from a natural-language message.
   * Delegates to FileMatching.extractFileHint so callers can get the hint
   * without importing FileMatching directly.
   *
   * @param {string} message
   * @returns {string|null}  partial name / type word, or null if nothing found
   */
  extractFileHint(message) {
    return extractFileHint(message);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Heuristic fast-path: returns true when the message is almost certainly a
   * FILE_SEND request, without spending an LLM call.
   *
   * Covers:
   *   - Explicit paths:          "send me /var/log/app.log"
   *   - Verb + file-type word:   "share the pdf", "forward me the report"
   *   - Demonstrative + type:    "this file", "that document", "the log"
   *   - Verb + pronoun:          "send that", "give me this", "forward it"
   *   - Type word alone (short): "the pdf please", "that spreadsheet"
   *
   * @param {string} message
   * @returns {boolean}
   */
  _isFileSendIntent(message) {
    if (!message || typeof message !== 'string') return false;

    // Explicit absolute / relative path after a send-like verb
    if (/\bsend\s+(me\s+)?(the\s+)?\/\S+/i.test(message)) return true;

    // Any send-like verb followed (within 80 chars) by a file-type noun
    const sendVerbs   = /\b(send|share|attach|give|get|forward|show|provide|transfer|gimme)\b/i;
    const fileTypes   = /\b(file|document|doc|attachment|pdf|image|photo|picture|log|logs|report|spreadsheet|zip|archive|code|script|config|data|csv|excel|word|video|audio|folder)\b/i;
    const pronouns    = /\b(this|that|it|them|these|those)\b/i;
    const demonstratives = /\b(this|that|my|the)\b/i;

    const hasSendVerb = sendVerbs.test(message);
    const hasFileType = fileTypes.test(message);
    const hasPronoun  = pronouns.test(message);

    // "send the pdf", "share that document", "give me the log"
    if (hasSendVerb && hasFileType) return true;

    // "send that", "give me this", "forward it" — verb + pronoun implies a file
    // (only when no other clear task/question signal is dominant)
    if (hasSendVerb && hasPronoun && !this._hasStrongNonFileSignal(message)) return true;

    // "this file", "that document", "the pdf" — demonstrative + file type,
    // even without an explicit send verb (user is pointing at something)
    if (demonstratives.test(message) && hasFileType && !this._hasStrongNonFileSignal(message)) return true;

    // Explicit "send me file <token>" pattern
    if (/\bsend\s+me\s+(file\s+)?\S+\.\w{1,6}\b/i.test(message)) return true;

    return false;
  }

  /**
   * Returns true when the message contains strong signals that it is a TASK or
   * QUESTION rather than a file-send request.  Used as a guard in _isFileSendIntent
   * to avoid false positives on messages like "show me how to use this file" or
   * "what does that document contain?".
   *
   * @param {string} message
   * @returns {boolean}
   */
  _hasStrongNonFileSignal(message) {
    // Question words suggest QUESTION intent
    if (/\b(how|why|what|when|where|who|explain|describe|tell me about|what does|what is|how do)\b/i.test(message)) return true;
    // Coding task keywords suggest TASK intent
    if (/\b(write|create|build|implement|fix|refactor|add|update|edit|modify|change|delete|make|code)\b/i.test(message)) return true;
    return false;
  }
}

module.exports = { IntentAgent };
