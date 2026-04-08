/**
 * DebuggingAgent
 *
 * Attempts to fix failing tests by analyzing the error output and
 * applying a targeted patch via Claude Code CLI.
 *
 * The Orchestrator calls this up to 3 times before marking a task FAILED.
 */
class DebuggingAgent {
  /**
   * @param {import('../claude/ClaudeCodeExecutor').ClaudeCodeExecutor} executor
   */
  constructor(executor) {
    this._executor = executor;
  }

  /**
   * Attempt to fix whatever caused the tests to fail.
   *
   * @param {string} task        - Original task description (for context)
   * @param {string} testOutput  - Raw output from the failed test run
   * @param {string} repoPath    - Absolute path to the repo workspace
   * @param {number} attempt     - Which retry this is (1-3), for logging
   * @param {function} [onProgress]
   * @returns {Promise<DebugResult>}
   */
  async fix(task, testOutput, repoPath, attempt, onProgress) {
    const prompt = `You are a debugging agent. Tests are failing after implementing this task:

Task: ${task}

Test failure output:
${testOutput}

Instructions:
- Read the error carefully
- Identify the root cause
- Apply a minimal targeted fix
- Do not rewrite working code
- Confirm what you changed in 1-2 sentences`;

    const result = await this._executor.run(prompt, repoPath, {
      disallowedTools: ['WebSearch', 'WebFetch'],
      onProgress,
    });

    return {
      success: result.success,
      output: result.output,
      attempt,
      budget: result.budget,
      exitCode: result.exitCode,
    };
  }
}

/**
 * @typedef {Object} DebugResult
 * @property {boolean} success
 * @property {string}  output
 * @property {number}  attempt
 * @property {object}  budget
 * @property {number}  exitCode
 */

module.exports = { DebuggingAgent };
