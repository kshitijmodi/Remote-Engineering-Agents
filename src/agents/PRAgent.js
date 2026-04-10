const { spawn } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';
const GH_BIN = IS_WINDOWS ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : 'gh';

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
  async createPR(taskId, taskText, repoPath, reviewNotes = null) {
    const branch = this._branchName(taskText, taskId);

    // 1. Create and checkout feature branch
    await this._git(['checkout', '-b', branch], repoPath);

    // 2. Disable CRLF warnings
    await this._git(['config', 'core.autocrlf', 'false'], repoPath);
    await this._git(['config', 'core.safecrlf', 'false'], repoPath);

    // 3. Stage all changes
    await this._git(['add', '-A'], repoPath);

    // 4. Commit only if there are uncommitted changes
    // (if /push is called after /init with no new changes, we still want to push existing commits)
    const status = await this._git(['status', '--porcelain'], repoPath);
    if (status.trim()) {
      const commitMsg = `feat: ${taskText.slice(0, 72)}`;
      await this._git(['commit', '-m', commitMsg], repoPath);
    }

    // 5. Push — use token-authenticated URL so subprocess git can auth
    const token = await this._ghToken(repoPath);
    const originUrl = await this._git(['remote', 'get-url', 'origin'], repoPath).catch(() => '');

    // If no remote origin, create the GitHub repo first
    if (!originUrl) {
      const whoami = await this._run(GH_BIN, ['api', 'user', '--jq', '.login'], repoPath);
      const username = whoami.trim();
      const repoName = require('path').basename(repoPath).replace(/\s+/g, '-');
      await this._run(GH_BIN, ['repo', 'create', repoName, '--public', '--source', '.'], repoPath).catch(() => {});
      const cleanUrl = `https://github.com/${username}/${repoName}`;
      await this._git(['remote', 'add', 'origin', cleanUrl], repoPath).catch(() =>
        this._git(['remote', 'set-url', 'origin', cleanUrl], repoPath)
      );
    }

    const finalOriginUrl = await this._git(['remote', 'get-url', 'origin'], repoPath);
    const authUrl = token ? finalOriginUrl.replace('https://', `https://${token}@`) : finalOriginUrl;
    await this._git(['remote', 'set-url', 'origin', authUrl], repoPath);
    try {
      await this._git(['push', '-u', 'origin', branch], repoPath);
    } finally {
      await this._git(['remote', 'set-url', 'origin', finalOriginUrl], repoPath).catch(() => {});
    }

    // 6. Try to open a PR via GitHub CLI
    const prTitle = `feat: ${taskText.slice(0, 72)}`;
    let prUrl = null;
    try {
      const reviewSection = reviewNotes ? `\n\n## Review Notes\n${reviewNotes}` : '';
      const prBody = `Automated PR created by WhatsApp agent.\n\nTask: ${taskText}${reviewSection}`;
      const out = await this._run(GH_BIN, ['pr', 'create', '--title', prTitle, '--body', prBody, '--head', branch], repoPath);
      prUrl = out.trim();
    } catch {
      // gh not available or PR creation failed — branch is pushed, that's enough
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
      const proc = spawn(bin, args, { cwd, shell: false, windowsHide: true });
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

  async _ghToken(cwd) {
    try {
      const out = await this._run(GH_BIN, ['auth', 'token'], cwd);
      return out.trim();
    } catch {
      return null;
    }
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
