const fs = require('fs');
const path = require('path');
const { ClaudeCodeExecutor } = require('../claude/ClaudeCodeExecutor');

const MAX_RAW_TURNS  = 20;  // raw turns kept verbatim
const HISTORY_FILE   = '.rea-context.json';

/**
 * ContextAgent
 *
 * Stores and retrieves per-repo conversation history with two-tier memory:
 *
 *   1. Raw turns  — last MAX_RAW_TURNS exchanges stored verbatim on disk.
 *                   Survives restarts; loaded back into the prompt as-is.
 *
 *   2. Summary    — when raw turns overflow MAX_RAW_TURNS, the oldest entries
 *                   are compressed into a running summary via a Haiku call.
 *                   The summary is prepended to raw turns in the context block,
 *                   giving the model awareness of much older history without
 *                   ballooning the prompt size.
 *
 * File format (per repo):  { summary: string, turns: Entry[] }
 * Backwards-compatible with the old plain-array format.
 */
class ContextAgent {
  constructor() {
    // Separate executor — never competes with the task pipeline budget
    this._executor = new ClaudeCodeExecutor({ maxInvocations: 10_000, timeoutMs: 30_000 });
    // Tracks repos currently being summarised to prevent concurrent Haiku calls
    this._summarising = new Set();
  }

  /**
   * Append a message to the repo's history.
   * Automatically trims overflow turns and fires a background summarisation.
   *
   * @param {string} repoPath
   * @param {'user'|'assistant'} role
   * @param {string} text
   * @param {object} [multimodal]
   */
  append(repoPath, role, text, multimodal = {}) {
    const data  = this._load(repoPath);
    const entry = { role, text: text.slice(0, 500), timestamp: new Date().toISOString() };

    if (multimodal.media && multimodal.media.length > 0) {
      entry.media = multimodal.media.map(m => ({
        type:     m.type,
        mimeType: m.mimeType ?? null,
        filename: m.filename ?? null,
        filesize: m.filesize ?? null,
      }));
    }

    if (multimodal.links && multimodal.links.length > 0) {
      entry.links = multimodal.links.map(l => ({
        url:         l.url,
        category:    l.category,
        textContent: l.textContent ? l.textContent.slice(0, 300) : null,
        error:       l.error ?? null,
      }));
    }

    data.turns.push(entry);

    // When raw turns overflow, pull the oldest off and summarise them in the background
    if (data.turns.length > MAX_RAW_TURNS) {
      const overflow = data.turns.splice(0, data.turns.length - MAX_RAW_TURNS);
      this._summariseAsync(repoPath, data.summary, overflow).catch(() => {});
    }

    this._save(repoPath, data);
  }

  /**
   * Get formatted history string to inject into prompts.
   * Format: [summary of older history] + [last MAX_RAW_TURNS turns verbatim]
   *
   * @param {string} repoPath
   * @returns {string}
   */
  getContextBlock(repoPath) {
    const { summary, turns } = this._load(repoPath);
    if (!summary && !turns.length) return '';

    let block = '';

    if (summary) {
      block += `Summary of earlier conversation:\n${summary}\n\n`;
    }

    if (turns.length) {
      const lines = turns.map(e => {
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
      block += `Recent conversation:\n${lines.join('\n')}\n`;
    }

    return `${block}\n---\n\n`;
  }

  /**
   * Clear history for a repo.
   * @param {string} repoPath
   */
  clear(repoPath) {
    this._save(repoPath, { summary: '', turns: [] });
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _filePath(repoPath) {
    return path.join(repoPath, HISTORY_FILE);
  }

  _load(repoPath) {
    try {
      const file = this._filePath(repoPath);
      if (!fs.existsSync(file)) return { summary: '', turns: [] };
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Backwards-compatible: old format was a plain array
      if (Array.isArray(raw)) return { summary: '', turns: raw };
      return { summary: raw.summary ?? '', turns: raw.turns ?? [] };
    } catch {
      return { summary: '', turns: [] };
    }
  }

  _save(repoPath, data) {
    try {
      fs.writeFileSync(this._filePath(repoPath), JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.warn('[ContextAgent] Failed to save history:', err.message);
    }
  }

  /**
   * Fire-and-forget: compress overflow turns into the running summary via Haiku.
   * Skips silently if a summarisation for this repo is already in flight.
   */
  async _summariseAsync(repoPath, existingSummary, overflowTurns) {
    if (this._summarising.has(repoPath)) return;
    this._summarising.add(repoPath);

    try {
      const overflowText = overflowTurns
        .map(e => `${e.role === 'user' ? 'User' : 'Assistant'}: ${e.text}`)
        .join('\n');

      const priorSummarySection = existingSummary
        ? `Existing summary:\n${existingSummary}\n\n`
        : '';

      const prompt = `You are summarising a conversation between a developer and a WhatsApp coding bot.
${priorSummarySection}New exchanges to incorporate:\n${overflowText}

Write a concise summary (max 200 words) covering:
- What the developer asked or requested
- What was built, fixed, or explained
- Any important decisions or open issues

Output only the summary text, no labels or preamble.`;

      const result = await this._executor.run(prompt, process.cwd(), {
        model: 'claude-haiku-4-5-20251001',
      });

      if (result.success && result.output.trim()) {
        // Reload in case turns were appended while we were summarising
        const data = this._load(repoPath);
        data.summary = result.output.trim();
        this._save(repoPath, data);
        console.log(`[ContextAgent] Summary updated for ${path.basename(repoPath)}`);
      }
    } catch (err) {
      console.warn('[ContextAgent] Summarisation failed:', err.message);
    } finally {
      this._summarising.delete(repoPath);
    }
  }
}

module.exports = { ContextAgent };
