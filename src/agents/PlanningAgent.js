const { confirmCancelModify } = require('../ui/ConfirmationPrompts');

/**
 * PlanningAgent
 *
 * Breaks a natural language task into numbered implementation steps
 * using Claude Code CLI. The Orchestrator passes these steps to the
 * Execution Agent as a structured prompt.
 */
class PlanningAgent {
  /**
   * @param {import('../claude/ClaudeCodeExecutor').ClaudeCodeExecutor} executor
   */
  constructor(executor) {
    this._executor = executor;
  }

  /**
   * @param {string} task     - Raw user task description
   * @param {string} repoPath - Absolute path to the repo workspace
   * @param {function} [onProgress]
   * @param {object} [opts]
   * @param {string} [opts.fileTree]     - Repo file listing to include as context
   * @param {string} [opts.context]      - Extra conversation context
   * @param {string} [opts.modification] - User-requested modification to a prior plan
   * @param {object} [opts.media]        - Multimodal content (attachments/links) from the user message
   * @returns {Promise<PlanResult>}
   */
  async plan(task, repoPath, onProgress, { fileTree = '', context = '', modification = '', media } = {}) {
    const repoSection = fileTree ? `\nRepo files:\n${fileTree}\n` : '';
    const contextSection = context ? `\nContext:\n${context}\n` : '';
    const modificationSection = modification ? `\nModification request: ${modification}\n` : '';

    const prompt = `You are a software planning agent. Analyze this repository and break the following task into clear, numbered implementation steps.
${repoSection}${contextSection}${modificationSection}
Task: ${task}

Rules:
- Be specific about which files to create or modify
- Each step should be a single, focused action
- Maximum 8 steps
- Output ONLY the numbered list, no other text

Example format:
1. Add exportToCsv() function to src/utils/export.js
2. Import the function in src/components/Table.js
3. Add export button to the Table component
4. Write tests in tests/export.test.js`;

    const result = await this._executor.run(prompt, repoPath, {
      allowedTools: ['Read', 'Glob', 'Grep'],
      model: 'claude-haiku-4-5-20251001',
      onProgress,
      media,
    });

    const steps = this._parseSteps(result.output);

    return {
      success: result.success && steps.length > 0,
      steps,
      rawOutput: result.output,
      budget: result.budget,
    };
  }

  /**
   * Build a confirmCancel button prompt summarising the generated plan.
   * The caller (OrchestratorAgent) sends this to the user and awaits
   * confirmation before proceeding to the coding stage.
   *
   * @param {Array<{id: number, description: string}>} steps - The generated plan steps.
   * @returns {{ type: 'quick_reply', payload: object }}     - Button prompt payload.
   */
  buildPlanApprovalPrompt(steps) {
    const stepLines = steps.map((s) => `${s.id}. ${s.description}`).join('\n');
    // Truncate long plans so the WhatsApp body stays readable
    const preview = stepLines.length <= 300 ? stepLines : `${stepLines.slice(0, 297)}...`;
    return confirmCancelModify(
      `Ready to execute? Tap a button or type /confirm, /cancel, or /modify <changes>`,
      {
        header: `📋 Plan (${steps.length} steps)`,
        footer: 'Modify = re-generate the plan with your changes',
      }
    );
  }

  _parseSteps(output) {
    // Strip markdown code fences the model sometimes wraps the list in
    const stripped = output.replace(/```[\w]*\n?/g, '');
    return stripped
      .split('\n')
      .map(l => l.trim())
      // Match "1." or "1)" with optional bold markers like "**1.**"
      .filter(l => /^(\*\*)?(\d+)[.)]\*?\*?/.test(l))
      .map((l, index) => ({
        id: index + 1,
        description: l.replace(/^(\*\*)?(\d+)[.)]\*?\*?\s*/, '').trim(),
      }))
      .filter(s => s.description);
  }
}

/**
 * @typedef {Object} PlanStep
 * @property {number} id
 * @property {string} description
 */

/**
 * @typedef {Object} PlanResult
 * @property {boolean}    success
 * @property {PlanStep[]} steps
 * @property {string}     rawOutput
 * @property {object}     budget
 */

module.exports = { PlanningAgent };
