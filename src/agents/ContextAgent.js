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
 * Each entry: {
 *   role: 'user'|'assistant',
 *   text: string,
 *   timestamp: string,
 *   media?: Array<{ type: string, mimeType: string|null, filename: string|null, filesize: number|null }>,
 *   links?: Array<{ url: string, category: string, textContent: string|null, error: string|null }>,
 * }
 */
class ContextAgent {
  /**
   * Append a message to the repo's history, optionally including multimodal content.
   * @param {string} repoPath
   * @param {'user'|'assistant'} role
   * @param {string} text
   * @param {object} [multimodal]
   * @param {Array<object>} [multimodal.media]  - media metadata from MultimodalHandler
   * @param {Array<object>} [multimodal.links]  - link results from LinkProcessor
   */
  append(repoPath, role, text, multimodal = {}) {
    const history = this._load(repoPath);
    const entry = { role, text: text.slice(0, 500), timestamp: new Date().toISOString() };

    // Store lightweight media metadata (no base64 data to keep file size manageable)
    if (multimodal.media && multimodal.media.length > 0) {
      entry.media = multimodal.media.map(m => ({
        type:     m.type,
        mimeType: m.mimeType ?? null,
        filename: m.filename ?? null,
        filesize: m.filesize ?? null,
      }));
    }

    // Store link summaries (truncate fetched text to avoid bloating the history file)
    if (multimodal.links && multimodal.links.length > 0) {
      entry.links = multimodal.links.map(l => ({
        url:         l.url,
        category:    l.category,
        textContent: l.textContent ? l.textContent.slice(0, 300) : null,
        error:       l.error ?? null,
      }));
    }

    history.push(entry);
    // Keep only last MAX_HISTORY entries
    const trimmed = history.slice(-MAX_HISTORY);
    this._save(repoPath, trimmed);
  }

  /**
   * Get formatted history string to prepend to prompts.
   * Multimodal attachments and link summaries are described inline.
   * @param {string} repoPath
   * @returns {string}
   */
  getContextBlock(repoPath) {
    const history = this._load(repoPath);
    if (!history.length) return '';
    const lines = history.map(e => {
      const speaker = e.role === 'user' ? 'User' : 'Assistant';
      let line = `${speaker}: ${e.text}`;

      if (e.media && e.media.length > 0) {
        const mediaDesc = e.media
          .map(m => {
            const name = m.filename ? ` (${m.filename})` : '';
            const size = m.filesize ? ` ${Math.round(m.filesize / 1024)}KB` : '';
            return `[${m.type}${name}${size}]`;
          })
          .join(', ');
        line += `\n  Attachments: ${mediaDesc}`;
      }

      if (e.links && e.links.length > 0) {
        const linkDesc = e.links
          .map(l => {
            if (l.error) return `[Link: ${l.url} — error: ${l.error}]`;
            if (l.textContent) return `[Link: ${l.url} — ${l.category} — "${l.textContent.slice(0, 100)}..."]`;
            return `[Link: ${l.url} — ${l.category}]`;
          })
          .join('\n  ');
        line += `\n  Links: ${linkDesc}`;
      }

      return line;
    });
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
