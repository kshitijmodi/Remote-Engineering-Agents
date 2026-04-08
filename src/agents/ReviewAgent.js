const { spawn } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

/**
 * ReviewAgent
 *
 * Gets the git diff of all uncommitted changes in the repo and asks
 * Claude Code to review it. Returns PASS or FAIL with reasons.
 *
 * Template from PRD:
 *   "Review the following code diff for bugs and style issues.
 *    Respond only with: PASS or FAIL and reasons."
 */
class ReviewAgent {
  /**
   * @param {import('../claude/ClaudeCodeExecutor').ClaudeCodeExecutor} executor
   */
  constructor(executor) {
    this._executor = executor;
  }

  /**
   * Review the current diff in the repo.
   *
   * @param {string} repoPath
   * @param {function} [onProgress]
   * @returns {Promise<ReviewResult>}
   */
  async review(repoPath, onProgress) {
    const diff = await this._getDiff(repoPath);

    if (!diff.trim()) {
      // No changes at all — treat as PASS so pipeline completes without a retry loop
      return { passed: true, verdict: 'PASS', reasons: 'No code changes to review — task was informational or already applied.', diff: '' };
    }

    const prompt = `Review the following code diff for bugs and style issues.
Respond only with: PASS or FAIL and reasons.

Diff:
${diff}`;

    const result = await this._executor.run(prompt, repoPath, {
      allowedTools: ['Read'],
      onProgress,
    });

    const parsed = this._parseVerdict(result.output);

    return {
      passed: parsed.verdict === 'PASS',
      verdict: parsed.verdict,
      reasons: parsed.reasons,
      diff,
      budget: result.budget,
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  async _getDiff(repoPath) {
    // Try diffs in order of preference until we find something non-empty:
    // 1. Unstaged changes (working tree vs HEAD)
    // 2. Staged changes
    // 3. Changes vs origin/main or origin/master (catches committed-but-not-pushed work)
    const attempts = [
      ['diff', 'HEAD'],                    // unstaged + staged vs HEAD
      ['diff', '--cached'],                 // only staged
      ['diff', 'origin/main...HEAD'],       // all commits ahead of origin/main
      ['diff', 'origin/master...HEAD'],     // all commits ahead of origin/master
    ];

    for (const args of attempts) {
      try {
        const out = await this._runGit(args, repoPath);
        if (out.trim()) return out;
      } catch { /* try next */ }
    }
    return ''; // genuinely nothing changed
  }

  _runGit(args, repoPath) {
    return new Promise((resolve, reject) => {
      const proc = spawn(
        IS_WINDOWS ? 'cmd' : 'git',
        IS_WINDOWS ? ['/c', 'git', ...args] : args,
        { cwd: repoPath, shell: false }
      );
      let out = '';
      let err = '';
      proc.stdout.on('data', d => (out += d));
      proc.stderr.on('data', d => (err += d));
      proc.on('close', code => {
        if (code === 0) resolve(out);
        else reject(new Error(`git ${args[0]} failed: ${err}`));
      });
      proc.on('error', reject);
    });
  }

  _parseVerdict(output) {
    const upper = output.toUpperCase();
    const verdict = upper.includes('PASS') && !upper.includes('FAIL') ? 'PASS' : 'FAIL';
    // Everything after the verdict word is the reason
    const reasonMatch = output.match(/(?:PASS|FAIL)[:\s-]*([\s\S]*)/i);
    const reasons = reasonMatch ? reasonMatch[1].trim() : output.trim();
    return { verdict, reasons };
  }
}

/**
 * @typedef {Object} ReviewResult
 * @property {boolean} passed
 * @property {string}  verdict   - 'PASS' or 'FAIL'
 * @property {string}  reasons
 * @property {string}  diff
 * @property {object}  [budget]
 */

module.exports = { ReviewAgent };
