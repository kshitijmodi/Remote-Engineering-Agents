const fs = require('fs');
const path = require('path');

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
 */
class ExecutionAgent {
  /**
   * @param {import('../claude/ClaudeCodeExecutor').ClaudeCodeExecutor} executor
   */
  constructor(executor) {
    this._executor = executor;
  }

  /**
   * Implement a task in the given repo.
   *
   * @param {string} task      - Natural language task description (or planned steps)
   * @param {string} repoPath  - Absolute path to the repo workspace
   * @param {function} [onProgress] - Called with each streaming event
   * @returns {Promise<CodingResult>}
   */
  async code(task, repoPath, onProgress) {
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
    });

    return {
      success: result.success,
      output: result.output,
      budget: result.budget,
      exitCode: result.exitCode,
    };
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
