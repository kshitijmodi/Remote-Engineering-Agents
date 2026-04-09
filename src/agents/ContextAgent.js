const fs = require('fs');
const path = require('path');

const MAX_HISTORY = 10; // max exchanges to keep per repo
const HISTORY_FILE = '.rea-context.json';

/**
 * ContextAgent
 *
 * Stores and retrieves conversation history per (userId, repoPath).
 * History is saved as a JSON file inside the repo folder so it
 * persists across bot restarts and accumulates across tasks.
 *
 * Each entry: { role: 'user'|'assistant', text: string, timestamp: string }
 */
class ContextAgent {
  /**
   * Append a message to the repo's history.
   * @param {string} repoPath
   * @param {'user'|'assistant'} role
   * @param {string} text
   */
  append(repoPath, role, text) {
    const history = this._load(repoPath);
    history.push({ role, text: text.slice(0, 500), timestamp: new Date().toISOString() });
    // Keep only last MAX_HISTORY entries
    const trimmed = history.slice(-MAX_HISTORY);
    this._save(repoPath, trimmed);
  }

  /**
   * Get formatted history string to prepend to prompts.
   * @param {string} repoPath
   * @returns {string}
   */
  getContextBlock(repoPath) {
    const history = this._load(repoPath);
    if (!history.length) return '';
    const lines = history.map(e => `${e.role === 'user' ? 'User' : 'Assistant'}: ${e.text}`);
    return `Previous conversation context for this repo:\n${lines.join('\n')}\n\n---\n\n`;
  }

  /**
   * Clear history for a repo.
   * @param {string} repoPath
   */
  clear(repoPath) {
    this._save(repoPath, []);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _filePath(repoPath) {
    return path.join(repoPath, HISTORY_FILE);
  }

  _load(repoPath) {
    try {
      const file = this._filePath(repoPath);
      if (!fs.existsSync(file)) return [];
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return [];
    }
  }

  _save(repoPath, history) {
    try {
      fs.writeFileSync(this._filePath(repoPath), JSON.stringify(history, null, 2), 'utf8');
    } catch (err) {
      console.warn('[ContextAgent] Failed to save history:', err.message);
    }
  }
}

module.exports = { ContextAgent };
