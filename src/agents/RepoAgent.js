const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const WORKSPACE_DIR = path.resolve(__dirname, '../../workspace');
const CHECKPOINTS_DIR = path.resolve(__dirname, '../../checkpoints');
const ACTIVE_REPOS_FILE = path.join(CHECKPOINTS_DIR, 'active-repos.json');

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
    fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
    this._loadActiveRepos();
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
    this._saveActiveRepos();
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
    // Check custom paths (from /init) first
    if (this._customPaths?.has(repoName)) {
      this._activeRepo.set(userId, repoName);
      this._saveActiveRepos();
      return { repoName, repoPath: this._customPaths.get(repoName) };
    }
    const repoPath = path.join(WORKSPACE_DIR, repoName);
    if (!fs.existsSync(repoPath)) {
      throw new RepoNotFoundError(repoName);
    }
    this._activeRepo.set(userId, repoName);
    this._saveActiveRepos();
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
   * Get the active repo name for display purposes.
   * @param {string} userId
   * @returns {string|null}
   */
  getActiveRepo(userId) {
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
  async init(userId, folderPath) {
    if (!fs.existsSync(folderPath)) {
      throw new Error(`Folder not found: ${folderPath}`);
    }

    const resolvedPath = path.resolve(folderPath);
    const name = path.basename(resolvedPath);

    // Ensure it's a git repo so Claude Code can commit changes
    const isGitRepo = fs.existsSync(path.join(resolvedPath, '.git'));
    if (!isGitRepo) {
      await this._git(['init'], resolvedPath);
      await this._git(['config', 'core.autocrlf', 'false'], resolvedPath);
      await this._git(['config', 'core.safecrlf', 'false'], resolvedPath);
      await this._git(['add', '-A'], resolvedPath);
      await this._git(['commit', '-m', 'Initial commit'], resolvedPath);
    }

    // Set as active workspace
    this._activeRepo.set(userId, name);
    this._customPaths = this._customPaths || new Map();
    this._customPaths.set(name, resolvedPath);
    this._saveActiveRepos();

    return { repoName: name, repoPath: resolvedPath, githubUrl: null };
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

  _saveActiveRepos() {
    try {
      const data = {
        activeRepos: Object.fromEntries(this._activeRepo),
        customPaths: Object.fromEntries(this._customPaths || new Map()),
      };
      fs.writeFileSync(ACTIVE_REPOS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.warn('[RepoAgent] Failed to save active repos:', err.message);
    }
  }

  _loadActiveRepos() {
    try {
      if (!fs.existsSync(ACTIVE_REPOS_FILE)) return;
      const data = JSON.parse(fs.readFileSync(ACTIVE_REPOS_FILE, 'utf8'));
      // Support both old format (plain object) and new format (with customPaths)
      const activeRepos = data.activeRepos ?? data;
      const customPaths = data.customPaths ?? {};
      for (const [userId, repoName] of Object.entries(activeRepos)) {
        this._activeRepo.set(userId, repoName);
      }
      this._customPaths = this._customPaths || new Map();
      for (const [name, p] of Object.entries(customPaths)) {
        if (fs.existsSync(p)) { // only restore if folder still exists
          this._customPaths.set(name, p);
        }
      }
    } catch (err) {
      console.warn('[RepoAgent] Failed to load active repos:', err.message);
    }
  }

  _repoNameFromUrl(url) {
    // https://github.com/user/my-repo.git → my-repo
    return path.basename(url.replace(/\.git$/, ''));
  }

  _ghRun(args, cwd) {
    const IS_WINDOWS = process.platform === 'win32';
    const GH_BIN = IS_WINDOWS ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : 'gh';
    return new Promise((resolve, reject) => {
      const proc = spawn(GH_BIN, args, { cwd, shell: false, windowsHide: true });
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
      const proc = spawn(bin, binArgs, { cwd, shell: false, windowsHide: true });
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
