/**
 * ExecutionStateManager — persists and restores pipeline execution state so
 * that a budget-exhausted run can resume from the last completed agent instead
 * of restarting from the beginning.
 */

const fs   = require('fs');
const path = require('path');

// Default path for the execution state file (next to .rea-context.json)
const DEFAULT_STATE_PATH = path.resolve(process.cwd(), '.rea-execution-state.json');

class ExecutionStateManager {
  /**
   * @param {string} [statePath] - optional override for the state file path
   */
  constructor(statePath) {
    this.statePath = statePath || DEFAULT_STATE_PATH;
  }

  /**
   * Load persisted execution state from disk.
   * Returns null if no state file exists or the file is unreadable.
   * @returns {{ currentAgentIndex: number, completedAgents: string[], taskId: string|null, timestamp: number }|null}
   */
  loadProgress() {
    try {
      if (!fs.existsSync(this.statePath)) return null;
      const raw = fs.readFileSync(this.statePath, 'utf8');
      const state = JSON.parse(raw);
      if (typeof state.currentAgentIndex !== 'number') return null;
      return state;
    } catch {
      return null;
    }
  }

  /**
   * Persist current execution state to disk.
   * @param {{ currentAgentIndex: number, completedAgents: string[], taskId?: string|null }} state
   */
  saveProgress(state) {
    const payload = {
      currentAgentIndex: state.currentAgentIndex,
      completedAgents:   Array.isArray(state.completedAgents) ? state.completedAgents : [],
      taskId:            state.taskId ?? null,
      timestamp:         Date.now(),
    };
    fs.writeFileSync(this.statePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  /**
   * Remove the state file once a run completes successfully so the next fresh
   * invocation always starts from the beginning.
   */
  clearProgress() {
    try {
      if (fs.existsSync(this.statePath)) fs.unlinkSync(this.statePath);
    } catch {
      // best-effort cleanup
    }
  }

  /**
   * Persist a checkpoint for a specific agent so the pipeline can resume
   * from that agent's output after a budget-exhausted interruption.
   * @param {string} agentName - identifier of the agent being checkpointed
   * @param {*} agentOutput    - the agent's result payload (must be JSON-serialisable)
   */
  saveCheckpoint(agentName, agentOutput) {
    const checkpointPath = this._checkpointPath(agentName);
    const payload = {
      agentName,
      output:    agentOutput,
      timestamp: Date.now(),
    };
    fs.writeFileSync(checkpointPath, JSON.stringify(payload, null, 2), 'utf8');
  }

  /**
   * Load a previously saved checkpoint for the given agent.
   * Returns null if no checkpoint exists or it cannot be parsed.
   * @param {string} agentName
   * @returns {{ agentName: string, output: *, timestamp: number }|null}
   */
  loadCheckpoint(agentName) {
    try {
      const checkpointPath = this._checkpointPath(agentName);
      if (!fs.existsSync(checkpointPath)) return null;
      const raw = fs.readFileSync(checkpointPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Remove the checkpoint file for the given agent (or all checkpoints when
   * no agentName is supplied) as part of a fresh-start or post-completion cleanup.
   * @param {string} [agentName] - omit to clear every checkpoint in the directory
   */
  clearCheckpoint(agentName) {
    try {
      if (agentName) {
        const checkpointPath = this._checkpointPath(agentName);
        if (fs.existsSync(checkpointPath)) fs.unlinkSync(checkpointPath);
      } else {
        const dir = path.dirname(this.statePath);
        const prefix = path.basename(this.statePath, '.json') + '.checkpoint.';
        for (const file of fs.readdirSync(dir)) {
          if (file.startsWith(prefix)) {
            try { fs.unlinkSync(path.join(dir, file)); } catch { /* best-effort */ }
          }
        }
      }
    } catch {
      // best-effort cleanup
    }
  }

  // ---------------------------------------------------------------------------
  // File context tracking (recently mentioned / accessed files)
  // ---------------------------------------------------------------------------

  /**
   * Record a file that was mentioned or accessed in the current conversation.
   * Persisted to disk so all pipeline agents share the same context.
   * Duplicate entries for the same resolved path are collapsed (timestamp bumped).
   * The list is capped at 50 entries to prevent unbounded growth.
   *
   * @param {{ filePath?: string|null, fileName?: string, mentionedAs?: string, action?: string }} fileEntry
   *   filePath    — resolved absolute path (may be null if not yet resolved)
   *   fileName    — bare filename; derived from filePath when omitted
   *   mentionedAs — how the user referred to it ("this file", "the document", …)
   *   action      — what happened ("mentioned" | "sent" | "accessed" | …)
   */
  addRecentFile(fileEntry) {
    const context = this._loadFileContext();
    const entry = {
      filePath:    fileEntry.filePath    || null,
      fileName:    fileEntry.fileName    || (fileEntry.filePath ? path.basename(fileEntry.filePath) : null),
      mentionedAs: fileEntry.mentionedAs || null,
      action:      fileEntry.action      || 'mentioned',
      timestamp:   Date.now(),
    };
    // Collapse duplicate resolved paths — move to front with updated timestamp
    if (entry.filePath) {
      const idx = context.recentFiles.findIndex(f => f.filePath === entry.filePath);
      if (idx !== -1) context.recentFiles.splice(idx, 1);
    }
    context.recentFiles.unshift(entry);
    if (context.recentFiles.length > 50) context.recentFiles.length = 50;
    this._saveFileContext(context);
  }

  /**
   * Return recently mentioned / accessed files, newest first.
   * @param {number} [limit=10]
   * @returns {Array<{ filePath: string|null, fileName: string|null, mentionedAs: string|null, action: string, timestamp: number }>}
   */
  getRecentFiles(limit = 10) {
    const context = this._loadFileContext();
    return context.recentFiles.slice(0, limit);
  }

  /**
   * Wipe the persisted file-context list.
   */
  clearRecentFiles() {
    this._saveFileContext({ recentFiles: [] });
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Derive a deterministic checkpoint file path from the agent name.
   * e.g. ".rea-execution-state.checkpoint.PlannerAgent.json"
   * @param {string} agentName
   * @returns {string}
   */
  _checkpointPath(agentName) {
    const dir  = path.dirname(this.statePath);
    const base = path.basename(this.statePath, '.json');
    return path.join(dir, `${base}.checkpoint.${agentName}.json`);
  }

  /**
   * Derive the path for the file-context store.
   * e.g. ".rea-execution-state.filecontext.json"
   * @returns {string}
   */
  _fileContextPath() {
    const dir  = path.dirname(this.statePath);
    const base = path.basename(this.statePath, '.json');
    return path.join(dir, `${base}.filecontext.json`);
  }

  /**
   * Load the file-context object from disk, returning a safe default on any error.
   * @returns {{ recentFiles: Array }}
   */
  _loadFileContext() {
    try {
      const p = this._fileContextPath();
      if (!fs.existsSync(p)) return { recentFiles: [] };
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.recentFiles)) return { recentFiles: [] };
      return parsed;
    } catch {
      return { recentFiles: [] };
    }
  }

  /**
   * Write the file-context object to disk.
   * @param {{ recentFiles: Array }} context
   */
  _saveFileContext(context) {
    fs.writeFileSync(this._fileContextPath(), JSON.stringify(context, null, 2), 'utf8');
  }
}

module.exports = ExecutionStateManager;
