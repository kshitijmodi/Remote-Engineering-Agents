const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { confirmCancelModify } = require('../ui/ConfirmationPrompts');

/**
 * ExecutionAgent
 *
 * Handles the coding + testing stages of the pipeline.
 *
 * 1. Runs Claude Code to implement the task
 * 2. Detects the test runner and runs tests via Claude Code
 * 3. Returns a structured result the Orchestrator uses to decide next state
 *
 * Does NOT retry or debug — that's the Debugging Agent's job.
 *
 * Emits:
 *   'stepStart'     { step, totalSteps }         — before each step begins
 *   'stepCompleted' { step, totalSteps, result }  — after each step finishes
 */
class ExecutionAgent extends EventEmitter {
  /**
   * @param {import('../claude/ClaudeCodeExecutor').ClaudeCodeExecutor} executor
   */
  constructor(executor) {
    super();
    this._executor = executor;
  }

  /**
   * Implement a task in the given repo.
   *
   * When `steps` is a non-empty array of `{id, description}` objects, each step
   * is executed as a separate invocation and `onProgress` receives a
   * `{ type: 'stepCompleted', step, result }` event after each one.
   *
   * @param {string} task      - Natural language task description (or planned steps)
   * @param {string} repoPath  - Absolute path to the repo workspace
   * @param {function} [onProgress] - Called with each streaming event (and stepCompleted events)
   * @param {Array<{id: number, description: string}>} [steps] - Structured plan steps
   * @param {{ attachments?: Array, links?: Array }} [media] - Multimodal context (images, PDFs, links)
   * @returns {Promise<CodingResult>}
   */
  async code(task, repoPath, onProgress, steps = [], media) {
    if (steps.length > 0) {
      return this._codeWithSteps(task, repoPath, onProgress, steps, media);
    }

    const prompt = `You are implementing a software task in this repository.

Task:
${task}

Instructions:
- Make only the changes necessary to complete the task
- Do not modify unrelated files
- Ensure existing code style is preserved
- DO NOT run git add, git commit, or git push — leave changes unstaged
- After making changes, confirm what was done in 2-3 sentences`;

    const result = await this._executor.run(prompt, repoPath, {
      disallowedTools: ['WebSearch', 'WebFetch'],
      onProgress,
      media,
    });

    return {
      success: result.success,
      output: result.output,
      budget: result.budget,
      exitCode: result.exitCode,
    };
  }

  /**
   * Execute each plan step as a separate invocation, emitting a stepCompleted
   * event via onProgress after each step finishes.
   * @private
   */
  async _codeWithSteps(task, repoPath, onProgress, steps, media) {
    let lastOutput = '';
    for (const step of steps) {
      this.emit('stepStart', { step, totalSteps: steps.length });
      onProgress?.({ type: 'stepStart', step, totalSteps: steps.length });

      const stepPrompt = `You are implementing a software task in this repository.

Task: ${task}

Current step (${step.id} of ${steps.length}): ${step.description}

Instructions:
- Implement only this step
- Do not modify unrelated files
- Ensure existing code style is preserved
- DO NOT run git add, git commit, or git push — leave changes unstaged
- After making changes, confirm what was done in 1-2 sentences`;

      const result = await this._executor.run(stepPrompt, repoPath, {
        disallowedTools: ['WebSearch', 'WebFetch'],
        onProgress: (e) => onProgress?.(e),
        media,
      });

      lastOutput = result.output;
      this.emit('stepCompleted', { step, totalSteps: steps.length, result });
      onProgress?.({ type: 'stepCompleted', step, totalSteps: steps.length, result });
    }

    return {
      success: true,
      output: lastOutput,
      budget: this._executor.budgetStatus,
      exitCode: 0,
    };
  }

  /**
   * Build a confirmCancelModify button prompt summarising what is about to be
   * implemented.  The caller (OrchestratorAgent) sends this to the user and
   * awaits confirmation before calling code().
   *
   * @param {string} task                                   - Natural language task description.
   * @param {Array<{id: number, description: string}>} [steps] - Structured plan steps (optional).
   * @returns {{ type: 'quick_reply', payload: object }}    - Button prompt payload.
   */
  buildExecutionDraftPrompt(task, steps = []) {
    const stepLines = steps.length
      ? steps.map((s) => `${s.id}. ${s.description}`).join('\n')
      : task;
    // Truncate long previews so the WhatsApp body stays readable
    const preview = stepLines.length <= 300 ? stepLines : `${stepLines.slice(0, 297)}...`;
    return confirmCancelModify(
      `🔧 *Ready to implement:*\n\n${preview}`,
      {
        header: 'Execute task?',
        footer: 'Reply /confirm, /cancel, or /modify <changes>',
      }
    );
  }

  /**
   * Run the repo's test suite via Claude Code.
   * Claude Code detects the test runner and executes it.
   *
   * @param {string} repoPath
   * @param {function} [onProgress]
   * @returns {Promise<TestResult>}
   */
  async test(repoPath, onProgress) {
    const testRunner = this._detectTestRunner(repoPath);

    // No test suite detected — skip rather than letting Claude guess and hang
    if (!testRunner) {
      return { passed: true, passedCount: 0, failedCount: 0, details: 'No test suite detected — skipping.', rawOutput: '', budget: this._executor.budgetStatus, executorSuccess: true };
    }

    const prompt = `Run the tests using: ${testRunner}

IMPORTANT: Run once and exit. Do not start watch mode. Set CI=true if needed.

Report the results in this exact format:
STATUS: PASS or FAIL
PASSED: <number>
FAILED: <number>
DETAILS: <one line summary of what failed, or "All tests passed">`;

    const result = await this._executor.run(prompt, repoPath, {
      allowedTools: ['Bash'],
      onProgress,
    });

    const parsed = this._parseTestOutput(result.output);

    return {
      passed: parsed.status === 'PASS',
      passedCount: parsed.passed,
      failedCount: parsed.failed,
      details: parsed.details,
      rawOutput: result.output,
      budget: result.budget,
      executorSuccess: result.success,
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Sniff the repo for a known test runner to give Claude a hint.
   * Falls back to null — Claude will figure it out.
   */
  _detectTestRunner(repoPath) {
    const checks = [
      { file: 'package.json',   key: 'scripts.test', command: 'npm test' },
      { file: 'pytest.ini',     command: 'pytest' },
      { file: 'setup.py',       command: 'pytest' },
      { file: 'pyproject.toml', command: 'pytest' },
      { file: 'Makefile',       command: 'make test' },
      { file: 'Cargo.toml',     command: 'cargo test' },
      { file: 'go.mod',         command: 'go test ./...' },
    ];

    for (const check of checks) {
      const filePath = path.join(repoPath, check.file);
      if (!fs.existsSync(filePath)) continue;

      if (check.key === 'scripts.test') {
        try {
          const pkg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (pkg.scripts?.test) return check.command;
        } catch { /* malformed package.json */ }
      } else {
        return check.command;
      }
    }

    return null;
  }

  _parseTestOutput(output) {
    const lines = output.split('\n');
    const find = (prefix) => {
      const line = lines.find(l => l.trim().startsWith(prefix));
      return line ? line.split(':').slice(1).join(':').trim() : null;
    };

    return {
      status:  find('STATUS')  ?? (output.toLowerCase().includes('fail') ? 'FAIL' : 'PASS'),
      passed:  parseInt(find('PASSED')  ?? '0', 10),
      failed:  parseInt(find('FAILED')  ?? '0', 10),
      details: find('DETAILS') ?? output.slice(0, 200),
    };
  }
}

/**
 * @typedef {Object} CodingResult
 * @property {boolean} success
 * @property {string}  output
 * @property {object}  budget
 * @property {number}  exitCode
 */

/**
 * @typedef {Object} TestResult
 * @property {boolean} passed
 * @property {number}  passedCount
 * @property {number}  failedCount
 * @property {string}  details
 * @property {string}  rawOutput
 * @property {object}  budget
 * @property {boolean} executorSuccess
 */

module.exports = { ExecutionAgent };
