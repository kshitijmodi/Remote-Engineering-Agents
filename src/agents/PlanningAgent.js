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
   * @returns {Promise<PlanResult>}
   */
  async plan(task, repoPath, onProgress) {
    const prompt = `You are a software planning agent. Analyze this repository and break the following task into clear, numbered implementation steps.

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
    });

    const steps = this._parseSteps(result.output);

    return {
      success: result.success && steps.length > 0,
      steps,
      rawOutput: result.output,
      budget: result.budget,
    };
  }

  _parseSteps(output) {
    return output
      .split('\n')
      .map(l => l.trim())
      .filter(l => /^\d+\./.test(l))
      .map(l => l.replace(/^\d+\.\s*/, '').trim())
      .filter(Boolean);
  }
}

/**
 * @typedef {Object} PlanResult
 * @property {boolean}  success
 * @property {string[]} steps
 * @property {string}   rawOutput
 * @property {object}   budget
 */

module.exports = { PlanningAgent };
