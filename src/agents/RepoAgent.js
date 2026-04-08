const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const WORKSPACE_DIR = path.resolve(__dirname, '../../workspace');

/**
 * RepoAgent
 *
 * Manages repo cloning, workspace isolation, and active repo switching.
 * Other agents call getActiveRepoPath() to know where to run Claude Code.
 *
 * Rules (MVP):
 *   - One active task per repo at a time (lock enforced)
 *   - Each repo lives in workspace/<repo-name>/
 *   - .env files are disallowed from Claude Code tool access
 */
class RepoAgent {
  constructor() {
    // userId → active repo name
    this._activeRepo = new Map();
    // repo name → true (locked by an in-progress task)
    this._locks = new Map();

    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  }

  /**
   * Clone a repo and set it as the user's active workspace.
   * If already cloned, just switches to it.
   *
   * @param {string} userId
   * @param {string} repoUrl
   * @returns {Promise<{ repoName: string, repoPath: string, alreadyCloned: boolean }>}
   */
  async connect(userId, repoUrl) {
    const repoName = this._repoNameFromUrl(repoUrl);
    const repoPath = path.join(WORKSPACE_DIR, repoName);

    let alreadyCloned = false;
    if (fs.existsSync(repoPath)) {
      alreadyCloned = true;
      // Fetch and reset to origin/HEAD to avoid tracking branch issues
      try {
        await this._git(['fetch', 'origin'], repoPath);
        await this._git(['checkout', 'main'], repoPath).catch(() =>
          this._git(['checkout', 'master'], repoPath)
        );
        await this._git(['reset', '--hard', 'origin/HEAD'], repoPath);
      } catch {
        // If update fails, just use what's there
      }
    } else {
      await this._git(['clone', repoUrl, repoPath], WORKSPACE_DIR);
    }

    this._activeRepo.set(userId, repoName);
    return { repoName, repoPath, alreadyCloned };
  }

  /**
   * Switch the user's active workspace to an already-cloned repo.
   *
   * @param {string} userId
   * @param {string} repoName - folder name inside workspace/
   * @returns {{ repoName: string, repoPath: string }}
   */
  switch(userId, repoName) {
    const repoPath = path.join(WORKSPACE_DIR, repoName);
    if (!fs.existsSync(repoPath)) {
      throw new RepoNotFoundError(repoName);
    }
    this._activeRepo.set(userId, repoName);
    return { repoName, repoPath };
  }

  /**
   * Get the filesystem path for the user's active repo.
   * Throws if no repo is active.
   *
   * @param {string} userId
   * @returns {string} absolute path
   */
  getActiveRepoPath(userId) {
    const repoName = this._activeRepo.get(userId);
    if (!repoName) throw new NoActiveRepoError(userId);
    // Check custom paths first (local folders set via /init)
    if (this._customPaths?.has(repoName)) {
      return this._customPaths.get(repoName);
    }
    return path.join(WORKSPACE_DIR, repoName);
  }

  /**
   * Get the active repo name for a user, or null.
   * @param {string} userId
   * @returns {string|null}
   */
  getActiveRepoName(userId) {
    return this._activeRepo.get(userId) ?? null;
  }

  /**
   * Initialize a local folder as a git repo, create it on GitHub, and set as active workspace.
   * Uses the folder as-is — no copying.
   *
   * @param {string} userId
   * @param {string} folderPath - Absolute path to the local project folder
   * @param {object} opts
   * @param {string} [opts.repoName]    - GitHub repo name (defaults to folder name)
   * @param {boolean} [opts.private]    - Make repo private (default: false)
   * @returns {Promise<{ repoName: string, repoPath: string, githubUrl: string }>}
   */
  async init(userId, folderPath, { repoName, private: isPrivate = false } = {}) {
    if (!fs.existsSync(folderPath)) {
      throw new Error(`Folder not found: ${folderPath}`);
    }

    const name = repoName || path.basename(folderPath);
    const resolvedPath = path.resolve(folderPath);

    // 1. Git init if not already a repo
    const isGitRepo = fs.existsSync(path.join(resolvedPath, '.git'));
    if (!isGitRepo) {
      await this._git(['init'], resolvedPath);
    }
    // Check if there are any commits (git init + previous failure leaves .git with no commits)
    const hasCommits = await this._git(['log', '--oneline', '-1'], resolvedPath).then(() => true).catch(() => false);
    if (!hasCommits) {
      await this._git(['config', 'core.autocrlf', 'false'], resolvedPath);
      await this._git(['config', 'core.safecrlf', 'false'], resolvedPath);
      // Ensure a .gitignore exists to exclude common junk before staging
      const gitignorePath = path.join(resolvedPath, '.gitignore');
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, [
          'node_modules/',
          '.wwebjs_auth*/',
          '.wwebjs_cache/',
          'workspace/',
          'logs/',
          'checkpoints/',
          '.env',
          '*.log',
        ].join('\n') + '\n');
      } else {
        // Append entries if not already present
        let existing = fs.readFileSync(gitignorePath, 'utf8');
        const entries = ['.wwebjs_auth*/', '.wwebjs_cache/', 'workspace/', '.env'];
        const toAdd = entries.filter(e => !existing.includes(e));
        if (toAdd.length) fs.appendFileSync(gitignorePath, '\n' + toAdd.join('\n') + '\n');
      }
      await this._git(['add', '-A'], resolvedPath);
      await this._git(['commit', '-m', 'Initial commit'], resolvedPath);
    }

    // 2. Create GitHub repo via gh CLI
    const privFlag = isPrivate ? '--private' : '--public';
    let githubUrl = '';
    try {
      const out = await this._ghRun(['repo', 'create', name, privFlag, '--source', '.', '--push'], resolvedPath);
      githubUrl = out.trim();
    } catch (err) {
      // Repo may already exist on GitHub — try adding remote and pushing
      try {
        const whoami = await this._ghRun(['api', 'user', '--jq', '.login'], resolvedPath);
        const username = whoami.trim();
        githubUrl = `https://github.com/${username}/${name}`;
        await this._git(['remote', 'add', 'origin', githubUrl], resolvedPath).catch(() => {});
        await this._git(['push', '-u', 'origin', 'HEAD'], resolvedPath);
      } catch (pushErr) {
        throw new Error(`GitHub repo creation failed: ${err.message}\nPush also failed: ${pushErr.message}`);
      }
    }

    // 3. Set as active workspace
    this._activeRepo.set(userId, name);
    // Register in the internal map so getActiveRepoPath works
    this._customPaths = this._customPaths || new Map();
    this._customPaths.set(name, resolvedPath);

    return { repoName: name, repoPath: resolvedPath, githubUrl };
  }

  /**
   * List all cloned repos in workspace/.
   * @returns {string[]}
   */
  listRepos() {
    return fs.readdirSync(WORKSPACE_DIR).filter((name) => {
      const p = path.join(WORKSPACE_DIR, name);
      return fs.statSync(p).isDirectory();
    });
  }

  /**
   * Acquire an exclusive lock on a repo for a task.
   * Throws if already locked (another task is running on this repo).
   *
   * @param {string} userId
   * @returns {function} release — call when the task finishes
   */
  acquireLock(userId) {
    const repoName = this._activeRepo.get(userId);
    if (!repoName) throw new NoActiveRepoError(userId);
    if (this._locks.get(repoName)) throw new RepoLockedError(repoName);

    this._locks.set(repoName, true);
    return () => this._locks.delete(repoName);
  }

  /**
   * Check if a repo is currently locked by an active task.
   * @param {string} userId
   * @returns {boolean}
   */
  isLocked(userId) {
    const repoName = this._activeRepo.get(userId);
    return repoName ? (this._locks.get(repoName) ?? false) : false;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _repoNameFromUrl(url) {
    // https://github.com/user/my-repo.git → my-repo
    return path.basename(url.replace(/\.git$/, ''));
  }

  _ghRun(args, cwd) {
    const IS_WINDOWS = process.platform === 'win32';
    const [bin, binArgs] = IS_WINDOWS
      ? ['cmd', ['/c', 'gh', ...args]]
      : ['gh', args];
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, binArgs, { cwd, shell: false });
      let out = '';
      let err = '';
      proc.stdout?.on('data', d => (out += d));
      proc.stderr?.on('data', d => (err += d));
      proc.on('close', code => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(err.trim() || `gh exit ${code}`));
      });
      proc.on('error', reject);
    });
  }

  _git(args, cwd) {
    const IS_WINDOWS = process.platform === 'win32';
    const [bin, binArgs] = IS_WINDOWS
      ? ['cmd', ['/c', 'git', ...args]]
      : ['git', args];

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, binArgs, { cwd, shell: false });
      let out = '';
      let err = '';
      proc.stdout?.on('data', (d) => (out += d));
      proc.stderr?.on('data', (d) => (err += d));
      proc.on('close', (code) => {
        if (code === 0) resolve(out.trim()); // stderr warnings (e.g. CRLF) are ignored on success
        else reject(new Error(`git ${args[0]} failed:\n${err.trim() || out.trim()}`));
      });
      proc.on('error', reject);
    });
  }
}

class RepoNotFoundError extends Error {
  constructor(name) {
    super(`Repo "${name}" not found in workspace. Use /connect <url> first.`);
    this.name = 'RepoNotFoundError';
  }
}

class NoActiveRepoError extends Error {
  constructor(userId) {
    super(`No active repo for user ${userId}. Use /connect <url> first.`);
    this.name = 'NoActiveRepoError';
  }
}

class RepoLockedError extends Error {
  constructor(repoName) {
    super(`Repo "${repoName}" is busy with another task. Wait for it to finish or /cancel.`);
    this.name = 'RepoLockedError';
  }
}

module.exports = { RepoAgent, RepoNotFoundError, NoActiveRepoError, RepoLockedError };
