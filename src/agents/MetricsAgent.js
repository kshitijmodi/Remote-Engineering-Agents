const fs = require('fs');
const path = require('path');

const METRICS_FILE = path.resolve(__dirname, '../../logs/metrics.json');

/**
 * MetricsAgent
 *
 * Tracks aggregate metrics across tasks for PRD success metrics validation:
 * - Task success/failure counts and success rate
 * - Retry counts per task
 * - Execution time per task
 *
 * Persists to logs/metrics.json
 */
class MetricsAgent {
  constructor() {
    const logsDir = path.dirname(METRICS_FILE);
    fs.mkdirSync(logsDir, { recursive: true });
    this._data = this._load();
  }

  /**
   * Record a successfully completed task.
   * @param {string} taskId
   * @param {string} userId
   * @param {object} retries  - { coding, debugging, review }
   * @param {object} stageTiming
   */
  recordSuccess(taskId, userId, retries, stageTiming) {
    const executionTimeMs = this._calcExecutionTime(stageTiming);
    this._data.tasks.push({
      taskId,
      userId,
      status: 'success',
      retries: { ...retries },
      executionTimeMs,
      endedAt: new Date().toISOString(),
    });
    this._save();
  }

  /**
   * Record a failed task.
   * @param {string} taskId
   * @param {string} userId
   * @param {string} reason
   * @param {object} retries
   * @param {object} stageTiming
   */
  recordFailure(taskId, userId, reason, retries, stageTiming) {
    const executionTimeMs = this._calcExecutionTime(stageTiming);
    this._data.tasks.push({
      taskId,
      userId,
      status: 'failed',
      reason,
      retries: { ...retries },
      executionTimeMs,
      endedAt: new Date().toISOString(),
    });
    this._save();
  }

  /**
   * Get aggregate summary stats.
   * @returns {{ total, succeeded, failed, successRate, avgExecutionTimeMs, avgDebugRetries }}
   */
  getSummary() {
    const tasks = this._data.tasks;
    const total = tasks.length;
    const succeeded = tasks.filter(t => t.status === 'success').length;
    const failed = tasks.filter(t => t.status === 'failed').length;
    const successRate = total > 0 ? Math.round((succeeded / total) * 100) : 0;

    const withTime = tasks.filter(t => t.executionTimeMs != null);
    const avgExecutionTimeMs = withTime.length > 0
      ? Math.round(withTime.reduce((sum, t) => sum + t.executionTimeMs, 0) / withTime.length)
      : 0;

    const totalRetries = tasks.reduce((sum, t) => sum + (t.retries?.debugging ?? 0), 0);
    const avgDebugRetries = total > 0 ? (totalRetries / total).toFixed(1) : '0';

    return { total, succeeded, failed, successRate, avgExecutionTimeMs, avgDebugRetries };
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _calcExecutionTime(stageTiming) {
    const start = stageTiming?.planningStart ?? stageTiming?.codingStart;
    return start ? Date.now() - start : null;
  }

  _load() {
    if (fs.existsSync(METRICS_FILE)) {
      try {
        return JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
      } catch { /* malformed — start fresh */ }
    }
    return { tasks: [] };
  }

  _save() {
    fs.writeFileSync(METRICS_FILE, JSON.stringify(this._data, null, 2));
  }
}

module.exports = { MetricsAgent };
