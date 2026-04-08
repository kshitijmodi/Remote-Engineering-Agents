const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.resolve(__dirname, '../../logs');
const CHECKPOINTS_DIR = path.resolve(__dirname, '../../checkpoints');
const CHECKPOINT_INTERVAL_MS = 2 * 60 * 1000; // 2 min
const FLUSH_INTERVAL_MS = 30 * 1000;           // 30s

/**
 * LoggingAgent
 *
 * - Writes structured logs to logs/task_<id>.log
 * - Checkpoints task state to checkpoints/task_<id>.json every 2 min
 * - Flushes log buffer every 30s
 * - Provides getTailLogs(taskId) for the /logs command
 */
class LoggingAgent {
  constructor() {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });

    // taskId → string[] (pending log lines)
    this._buffers = new Map();
    // taskId → NodeJS.Timer
    this._flushTimers = new Map();
    this._checkpointTimers = new Map();
  }

  /**
   * Start tracking a task. Begins flush + checkpoint timers.
   * @param {string} taskId
   */
  startTask(taskId) {
    this._buffers.set(taskId, []);
    this.log(taskId, 'TASK_START', `Task ${taskId} started`);

    // Flush every 30s
    const flushTimer = setInterval(() => this._flush(taskId), FLUSH_INTERVAL_MS);
    this._flushTimers.set(taskId, flushTimer);
  }

  /**
   * Start auto-checkpointing a task's state every 2 min.
   * @param {string} taskId
   * @param {function(): object} getState - Called to get current task state snapshot
   */
  startCheckpointing(taskId, getState) {
    const timer = setInterval(() => {
      this.checkpoint(taskId, getState());
    }, CHECKPOINT_INTERVAL_MS);
    this._checkpointTimers.set(taskId, timer);
  }

  /**
   * Append a log entry for a task.
   * @param {string} taskId
   * @param {string} level   - e.g. 'INFO', 'ERROR', 'STATE'
   * @param {string} message
   * @param {object} [data]
   */
  log(taskId, level, message, data) {
    const entry = {
      ts: new Date().toISOString(),
      taskId,
      level,
      message,
      ...(data ? { data } : {}),
    };
    const line = JSON.stringify(entry);

    if (!this._buffers.has(taskId)) this._buffers.set(taskId, []);
    this._buffers.get(taskId).push(line);
  }

  /**
   * Write a checkpoint JSON for a task.
   * @param {string} taskId
   * @param {object} state
   */
  checkpoint(taskId, state) {
    const filePath = path.join(CHECKPOINTS_DIR, `task_${taskId}.json`);
    const data = { ...state, checkpointedAt: new Date().toISOString() };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    this.log(taskId, 'CHECKPOINT', 'State checkpointed', { stage: state.status });
  }

  /**
   * Load the last checkpoint for a task, or null if none.
   * @param {string} taskId
   * @returns {object|null}
   */
  loadCheckpoint(taskId) {
    const filePath = path.join(CHECKPOINTS_DIR, `task_${taskId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Return the last N log lines for a task as a formatted string.
   * Used by the /logs slash command.
   * @param {string} taskId
   * @param {number} [lines=20]
   * @returns {string}
   */
  getTailLogs(taskId, lines = 20) {
    this._flush(taskId);
    const filePath = path.join(LOGS_DIR, `task_${taskId}.log`);
    if (!fs.existsSync(filePath)) return `No logs found for task ${taskId}`;

    const all = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    return all
      .slice(-lines)
      .map(line => {
        try {
          const e = JSON.parse(line);
          return `[${e.ts.slice(11, 19)}] ${e.level}: ${e.message}`;
        } catch {
          return line;
        }
      })
      .join('\n');
  }

  /**
   * Stop logging for a task and flush remaining buffer.
   * @param {string} taskId
   */
  endTask(taskId) {
    this.log(taskId, 'TASK_END', `Task ${taskId} ended`);
    this._flush(taskId);
    clearInterval(this._flushTimers.get(taskId));
    clearInterval(this._checkpointTimers.get(taskId));
    this._flushTimers.delete(taskId);
    this._checkpointTimers.delete(taskId);
    this._buffers.delete(taskId);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _flush(taskId) {
    const buffer = this._buffers.get(taskId);
    if (!buffer?.length) return;

    const filePath = path.join(LOGS_DIR, `task_${taskId}.log`);
    fs.appendFileSync(filePath, buffer.join('\n') + '\n');
    this._buffers.set(taskId, []);
  }
}

module.exports = { LoggingAgent };
