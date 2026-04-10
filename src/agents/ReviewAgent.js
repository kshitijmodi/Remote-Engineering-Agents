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
      return { passed: true, verdict: 'PASS', reasons: 'No code changes to review.', recap: 'No code changes detected.', diff: '' };
    }

    // Skip full review for tiny diffs — low risk, save an invocation
    const diffLines = diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-')).length;
    if (diffLines < 10) {
      const recap = `${diffLines} lines changed — auto-approved.`;
      return { passed: true, verdict: 'PASS', reasons: `Small diff (${diffLines} lines) — auto-approved.`, recap, diff };
    }

    const prompt = `Review the following code diff for bugs and style issues.
Respond only with: PASS or FAIL and reasons.

Diff:
${diff}`;

    const result = await this._executor.run(prompt, repoPath, {
      allowedTools: ['Read'],
      model: 'claude-haiku-4-5-20251001',
      onProgress,
    });

    const parsed = this._parseVerdict(result.output);
    const recap = this._generateRecap(parsed, diffLines);

    return {
      passed: parsed.verdict === 'PASS',
      verdict: parsed.verdict,
      reasons: parsed.reasons,
      recap,
      diff,
      budget: result.budget,
    };
  }

  _generateRecap(parsed, diffLines) {
    if (parsed.verdict === 'PASS') {
      return `${diffLines} lines changed, review passed.`;
    }
    return `${diffLines} lines changed, review found issues: ${parsed.reasons}`;
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
        { cwd: repoPath, shell: false, windowsHide: true }
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
    const lines = output.trim().split('\n');
    // Look for a line that starts with PASS or FAIL — that's the verdict line
    for (const line of lines) {
      const t = line.trim().toUpperCase();
      if (t.startsWith('PASS')) return { verdict: 'PASS', reasons: line.replace(/^PASS[:\s-]*/i, '').trim() || 'Looks good.' };
      if (t.startsWith('FAIL')) return { verdict: 'FAIL', reasons: line.replace(/^FAIL[:\s-]*/i, '').trim() || output.trim() };
    }
    // No clear verdict line — fall back to scanning full text
    const upper = output.toUpperCase();
    const failFirst = upper.indexOf('FAIL');
    const passFirst = upper.indexOf('PASS');
    if (failFirst !== -1 && (passFirst === -1 || failFirst < passFirst)) {
      return { verdict: 'FAIL', reasons: output.trim() };
    }
    if (passFirst !== -1) {
      return { verdict: 'PASS', reasons: output.trim() };
    }
    // Can't determine — default to PASS to avoid infinite retry loops
    return { verdict: 'PASS', reasons: 'Could not parse verdict — defaulting to PASS.' };
  }
}

/**
 * @typedef {Object} ReviewResult
 * @property {boolean} passed
 * @property {string}  verdict   - 'PASS' or 'FAIL'
 * @property {string}  reasons
 * @property {string}  recap     - one-line summary for completion message
 * @property {string}  diff
 * @property {object}  [budget]
 */

module.exports = { ReviewAgent };
