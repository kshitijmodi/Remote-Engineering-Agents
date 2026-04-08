const { spawn } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

/**
 * PRAgent
 *
 * After review passes:
 * 1. Creates a feature branch
 * 2. Stages + commits all changes
 * 3. Pushes to remote
 * 4. Creates a PR via GitHub CLI (gh) if available, otherwise returns branch info
 */
class PRAgent {
  /**
   * @param {string} taskId
   * @param {string} taskText   - Used for branch name + commit message
   * @param {string} repoPath
   * @returns {Promise<PRResult>}
   */
  async createPR(taskId, taskText, repoPath) {
    const branch = this._branchName(taskText, taskId);

    // 1. Create and checkout feature branch
    await this._git(['checkout', '-b', branch], repoPath);

    // 2. Stage all changes
    await this._git(['add', '-A'], repoPath);

    // 3. Check if there's anything to commit
    const status = await this._git(['status', '--porcelain'], repoPath);
    if (!status.trim()) {
      throw new Error('Nothing to commit — no changes found in the repo.');
    }

    // 4. Commit
    const commitMsg = `feat: ${taskText.slice(0, 72)}`;
    await this._git(['commit', '-m', commitMsg], repoPath);

    // 4. Push
    await this._git(['push', 'origin', branch], repoPath);

    // 5. Try to open a PR via GitHub CLI
    let prUrl = null;
    const ghAvailable = await this._commandExists('gh');
    if (ghAvailable) {
      try {
        const prBody = `Automated PR created by WhatsApp agent.\n\nTask: ${taskText}`;
        const out = await this._run(
          IS_WINDOWS ? 'cmd' : 'gh',
          IS_WINDOWS
            ? ['/c', 'gh', 'pr', 'create', '--title', commitMsg, '--body', prBody, '--head', branch]
            : ['pr', 'create', '--title', commitMsg, '--body', prBody, '--head', branch],
          repoPath
        );
        prUrl = out.trim();
      } catch {
        // gh auth not set up — branch is pushed, PR creation skipped
      }
    }

    return { branch, committed: true, pushed: true, prUrl };
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _branchName(taskText, taskId) {
    const slug = taskText
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 5)
      .join('-');
    return `feature/${slug}-${taskId}`;
  }

  _git(args, cwd) {
    return this._run(
      IS_WINDOWS ? 'cmd' : 'git',
      IS_WINDOWS ? ['/c', 'git', ...args] : args,
      cwd
    );
  }

  _run(bin, args, cwd) {
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, { cwd, shell: false });
      let out = '';
      let err = '';
      proc.stdout?.on('data', d => (out += d));
      proc.stderr?.on('data', d => (err += d));
      proc.on('close', code => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(err.trim() || `exit ${code}`));
      });
      proc.on('error', reject);
    });
  }

  async _commandExists(cmd) {
    try {
      await this._run(
        IS_WINDOWS ? 'cmd' : 'which',
        IS_WINDOWS ? ['/c', 'where', cmd] : [cmd],
        process.cwd()
      );
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * @typedef {Object} PRResult
 * @property {string}       branch
 * @property {boolean}      committed
 * @property {boolean}      pushed
 * @property {string|null}  prUrl
 */

module.exports = { PRAgent };
