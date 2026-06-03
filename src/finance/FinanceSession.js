/**
 * Finance mode session manager.
 *
 * Tracks per-user session state: whether they are in finance mode and the
 * full conversation history to pass to ArthaOS on every query.
 *
 * Sessions auto-expire after TIMEOUT_MS of inactivity.
 */

const TIMEOUT_MS  = 30 * 60 * 1000; // 30 min
const MAX_HISTORY = 40;              // 20 turns × 2 messages

class FinanceSession {
  constructor() {
    this._sessions = new Map(); // userId → { history, lastActivity }
  }

  /** Enter finance mode for a user (starts a fresh history). */
  enter(userId) {
    this._sessions.set(userId, { history: [], lastActivity: Date.now() });
  }

  /** Exit finance mode and wipe history. */
  exit(userId) {
    this._sessions.delete(userId);
  }

  /**
   * Returns true if the user is in an active, non-expired session.
   * Returns false (and deletes the session) if it has timed out.
   */
  isActive(userId) {
    const s = this._sessions.get(userId);
    if (!s) return false;
    if (Date.now() - s.lastActivity > TIMEOUT_MS) {
      this._sessions.delete(userId);
      return false;
    }
    return true;
  }

  /** Get a copy of the current history array (safe to mutate). */
  getHistory(userId) {
    return [...(this._sessions.get(userId)?.history ?? [])];
  }

  /**
   * Append one user↔assistant exchange to history.
   * Trims to MAX_HISTORY messages (oldest dropped first).
   */
  addTurn(userId, userMsg, assistantMsg) {
    const s = this._sessions.get(userId);
    if (!s) return;
    s.history.push({ role: 'user',      content: userMsg      });
    s.history.push({ role: 'assistant', content: assistantMsg });
    s.lastActivity = Date.now();
    if (s.history.length > MAX_HISTORY) {
      s.history = s.history.slice(-MAX_HISTORY);
    }
  }
}

module.exports = { FinanceSession };
