const { randomUUID } = require('crypto');
const { BudgetExceededError } = require('../claude/ClaudeCodeExecutor');

const MAX_RETRIES = 3;

const STATES = {
  QUEUED:     'queued',
  PLANNING:   'planning',
  CODING:     'coding',
  TESTING:    'testing',
  DEBUGGING:  'debugging',
  REVIEW:     'review',
  PR_CREATED: 'pr_created',
  PAUSED:     'paused',   // budget hit
  FAILED:     'failed',
  CANCELLED:  'cancelled',
};

/**
 * OrchestratorAgent — the state machine.
 *
 * State flow:
 *   queued → planning → coding → testing
 *                                  ├── pass → review
 *                                  └── fail → debugging
 *                                               ├── fix → testing (max 3 retries)
 *                                               └── fail → FAILED
 *   review
 *     ├── pass → pr_created
 *     └── fail → coding (1 retry)
 *
 * Budget exhaustion → PAUSED → user sends /resume → resumes from current stage
 * User sends /cancel → CANCELLED
 */
class OrchestratorAgent {
  /**
   * @param {object} agents
   * @param {import('./PlanningAgent').PlanningAgent}   agents.planning
   * @param {import('./ExecutionAgent').ExecutionAgent} agents.execution
   * @param {import('./DebuggingAgent').DebuggingAgent} agents.debugging
   * @param {import('./ReviewAgent').ReviewAgent}       agents.review
   * @param {import('./LoggingAgent').LoggingAgent}     agents.logging
   * @param {import('../claude/ClaudeCodeExecutor').ClaudeCodeExecutor} agents.executor
   * @param {function(string, string): Promise<void>} notify  - send WhatsApp message to user
   */
  constructor(agents, notify) {
    this._agents = agents;
    this._notify = notify;
    // taskId → task object
    this._tasks = new Map();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Start a new task for a user.
   * @param {string} userId
   * @param {string} taskText
   * @param {string} repoPath
   * @returns {string} taskId
   */
  startTask(userId, taskText, repoPath) {
    const taskId = randomUUID().slice(0, 8);
    const task = {
      taskId,
      userId,
      taskText,
      repoPath,
      status: STATES.QUEUED,
      retries: { coding: 0, debugging: 0, review: 0 },
      lastTestOutput: '',
      planSteps: [],
      invocations: 0,
    };
    this._tasks.set(taskId, task);

    const { logging } = this._agents;
    logging.startTask(taskId);
    logging.startCheckpointing(taskId, () => this._snapshot(task));

    // Run async — don't await
    this._run(task).catch(err => {
      logging.log(taskId, 'ERROR', 'Unhandled orchestrator error', { err: err.message });
    });

    return taskId;
  }

  /**
   * Resume a paused task after /resume (budget extended externally).
   * @param {string} userId
   */
  resumeTask(userId) {
    const task = this._getActiveTask(userId);
    if (!task) {
      this._notify(userId, 'No paused task to resume.');
      return;
    }
    if (task.status !== STATES.PAUSED) {
      this._notify(userId, `Task is in state "${task.status}", not paused.`);
      return;
    }
    task.status = task._pausedAtStage ?? STATES.CODING;
    this._agents.logging.log(task.taskId, 'INFO', 'Task resumed by user');
    this._run(task).catch(err => {
      this._agents.logging.log(task.taskId, 'ERROR', 'Resume error', { err: err.message });
    });
  }

  /**
   * Cancel the active task for a user.
   * @param {string} userId
   */
  cancelTask(userId) {
    const task = this._getActiveTask(userId);
    if (!task) return;
    task.status = STATES.CANCELLED;
    this._agents.logging.log(task.taskId, 'INFO', 'Task cancelled by user');
    this._agents.logging.endTask(task.taskId);
  }

  /**
   * Get the most recent task for a user (any state).
   * @param {string} userId
   * @returns {object|null}
   */
  getActiveTask(userId) {
    return this._getActiveTask(userId);
  }

  // ─── State machine ─────────────────────────────────────────────────────────

  async _run(task) {
    const { logging } = this._agents;

    try {
      if (task.status === STATES.QUEUED || task.status === STATES.PLANNING) {
        await this._stagePlanning(task);
      }

      if (task.status === STATES.CODING) {
        await this._stageCoding(task);
      }

      // testing → debugging loop
      while (
        task.status === STATES.TESTING ||
        task.status === STATES.DEBUGGING
      ) {
        if (task.status === STATES.TESTING) {
          await this._stageTesting(task);
        }
        if (task.status === STATES.DEBUGGING) {
          await this._stageDebugging(task);
        }
      }

      if (task.status === STATES.REVIEW) {
        await this._stageReview(task);
      }

      if (task.status === STATES.PR_CREATED) {
        logging.endTask(task.taskId);
      }

    } catch (err) {
      if (err instanceof BudgetExceededError) {
        task._pausedAtStage = task.status;
        task.status = STATES.PAUSED;
        logging.log(task.taskId, 'WARN', 'Budget exhausted — task paused');
        await this._notify(
          task.userId,
          `Task hit execution limit (${err.budget.current}/${err.budget.max}).\n` +
          `Stage: ${task._pausedAtStage}\n` +
          `Reply /resume to grant 10 more, or /cancel to abort.`
        );
      } else if (task.status !== STATES.CANCELLED) {
        task.status = STATES.FAILED;
        logging.log(task.taskId, 'ERROR', 'Task failed with error', { err: err.message });
        await this._notify(task.userId, `Task FAILED: ${err.message}`);
        logging.endTask(task.taskId);
      }
    }
  }

  async _stagePlanning(task) {
    const { planning, logging } = this._agents;
    this._transition(task, STATES.PLANNING);

    await this._notify(task.userId, `⏳ *Planning* your task...\nBudget: ${this._budgetStr()}`);
    logging.log(task.taskId, 'STATE', 'Entering planning stage');

    const result = await planning.plan(task.taskText, task.repoPath, (e) =>
      logging.log(task.taskId, 'DEBUG', 'planning event', { type: e.type })
    );

    if (!result.success || result.steps.length === 0) {
      throw new Error('Planning agent produced no steps.');
    }

    task.planSteps = result.steps;
    logging.log(task.taskId, 'INFO', `Plan produced ${result.steps.length} steps`, { steps: result.steps });
    await this._notify(
      task.userId,
      `✅ *Planning complete* (${result.steps.length} steps)\n${result.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n⏳ *Starting coding...* Budget: ${this._budgetStr()}`
    );
    this._transition(task, STATES.CODING);
  }

  async _stageCoding(task) {
    const { execution, logging } = this._agents;

    const taskPrompt = task.planSteps.length
      ? `Task: ${task.taskText}\n\nImplementation steps:\n${task.planSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : task.taskText;

    const retryNote = task.retries.coding > 0 ? ` (retry ${task.retries.coding})` : '';
    logging.log(task.taskId, 'STATE', 'Entering coding stage', { retry: task.retries.coding });
    await this._notify(task.userId, `⏳ *Coding${retryNote}* — Claude Code is writing code...\nBudget: ${this._budgetStr()}`);

    const result = await execution.code(taskPrompt, task.repoPath, (e) =>
      logging.log(task.taskId, 'DEBUG', 'coding event', { type: e.type })
    );

    logging.log(task.taskId, 'INFO', 'Coding complete', { success: result.success });
    await this._notify(
      task.userId,
      `✅ *Coding complete*\n⏳ *Running tests...* Budget: ${this._budgetStr()}`
    );
    this._transition(task, STATES.TESTING);
  }

  async _stageTesting(task) {
    const { execution, logging } = this._agents;

    logging.log(task.taskId, 'STATE', 'Entering testing stage');
    await this._notify(task.userId, `⏳ *Testing* — running test suite...\nBudget: ${this._budgetStr()}`);

    const result = await execution.test(task.repoPath, (e) =>
      logging.log(task.taskId, 'DEBUG', 'testing event', { type: e.type })
    );

    task.lastTestOutput = result.rawOutput;
    logging.log(task.taskId, 'INFO', 'Test run complete', {
      passed: result.passedCount,
      failed: result.failedCount,
    });

    if (result.passed) {
      await this._notify(
        task.userId,
        `✅ *Tests passed* (${result.passedCount}/${result.passedCount + result.failedCount})\n⏳ *Starting review...* Budget: ${this._budgetStr()}`
      );
      this._transition(task, STATES.REVIEW);
    } else {
      if (task.retries.debugging >= MAX_RETRIES) {
        task.status = STATES.FAILED;
        await this._notify(
          task.userId,
          `❌ *Task FAILED* after ${MAX_RETRIES} debug attempts.\nError: ${result.details}\nReply /resume to retry or /logs for full trace.`
        );
        this._agents.logging.endTask(task.taskId);
        return;
      }
      task.retries.debugging += 1;
      await this._notify(
        task.userId,
        `⚠️ *Tests failed* (${result.failedCount} failing)\n⏳ *Debugging* attempt ${task.retries.debugging}/${MAX_RETRIES}...\nBudget: ${this._budgetStr()}`
      );
      this._transition(task, STATES.DEBUGGING);
    }
  }

  async _stageDebugging(task) {
    const { debugging, logging } = this._agents;

    logging.log(task.taskId, 'STATE', 'Entering debugging stage', { attempt: task.retries.debugging });
    await this._notify(task.userId, `⏳ *Debugging* — applying fix...\nBudget: ${this._budgetStr()}`);

    const result = await debugging.fix(
      task.taskText,
      task.lastTestOutput,
      task.repoPath,
      task.retries.debugging,
      (e) => logging.log(task.taskId, 'DEBUG', 'debugging event', { type: e.type })
    );

    logging.log(task.taskId, 'INFO', 'Debug patch applied', { success: result.success });
    await this._notify(
      task.userId,
      `✅ *Patch applied*\n⏳ *Re-running tests...* Budget: ${this._budgetStr()}`
    );
    this._transition(task, STATES.TESTING);
  }

  async _stageReview(task) {
    const { review, logging } = this._agents;

    logging.log(task.taskId, 'STATE', 'Entering review stage', { retry: task.retries.review });
    await this._notify(task.userId, `⏳ *Reviewing code* — checking diff for issues...\nBudget: ${this._budgetStr()}`);

    const result = await review.review(task.repoPath, (e) =>
      logging.log(task.taskId, 'DEBUG', 'review event', { type: e.type })
    );

    logging.log(task.taskId, 'INFO', `Review: ${result.verdict}`, { reasons: result.reasons });

    if (result.passed) {
      await this._notify(task.userId, `✅ *Review passed*\n⏳ *Creating PR...* Budget: ${this._budgetStr()}`);
      await this._stagePR(task);
    } else {
      if (task.retries.review >= 1) {
        task.status = STATES.FAILED;
        await this._notify(
          task.userId,
          `Review FAILED after retry.\nReasons: ${result.reasons}\nUse /logs for details.`
        );
        this._agents.logging.endTask(task.taskId);
        return;
      }
      task.retries.review += 1;
      task.retries.coding += 1;
      await this._notify(
        task.userId,
        `Review: FAIL. Reasons: ${result.reasons}\nRetrying coding stage. Budget: ${this._budgetStr()}`
      );
      this._transition(task, STATES.CODING);
      await this._stageCoding(task);
    }
  }

  async _stagePR(task) {
    const { pr, logging } = this._agents;
    logging.log(task.taskId, 'STATE', 'Creating PR');

    try {
      const result = await pr.createPR(task.taskId, task.taskText, task.repoPath);
      this._transition(task, STATES.PR_CREATED);

      const prLine = result.prUrl
        ? `PR: ${result.prUrl}`
        : `Branch pushed: ${result.branch} (run \`gh pr create\` to open PR)`;

      await this._notify(
        task.userId,
        `🎉 *Task complete!*\nBranch: \`${result.branch}\`\n${prLine}\nBudget used: ${this._budgetStr()}`
      );
    } catch (err) {
      logging.log(task.taskId, 'WARN', 'PR creation failed', { err: err.message });
      this._transition(task, STATES.PR_CREATED);
      await this._notify(
        task.userId,
        `Task complete! Code changes are in: ${task.repoPath}\n` +
        `PR creation failed: ${err.message}\nCommit and push manually if needed.`
      );
    }

    this._agents.logging.endTask(task.taskId);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _transition(task, newState) {
    const prev = task.status;
    task.status = newState;
    this._agents.logging.log(task.taskId, 'STATE', `${prev} → ${newState}`);
  }

  _budgetStr() {
    const b = this._agents.executor.budgetStatus;
    return `${b.current}/${b.max}`;
  }

  _getActiveTask(userId) {
    for (const task of this._tasks.values()) {
      if (task.userId === userId && ![STATES.FAILED, STATES.PR_CREATED, STATES.CANCELLED].includes(task.status)) {
        return task;
      }
    }
    // Also return the most recent ended task for /logs
    for (const task of [...this._tasks.values()].reverse()) {
      if (task.userId === userId) return task;
    }
    return null;
  }

  _snapshot(task) {
    return {
      taskId:    task.taskId,
      status:    task.status,
      repo:      task.repoPath,
      taskText:  task.taskText,
      retries:   task.retries,
      invocations: this._agents.executor.budgetStatus.current,
    };
  }
}

module.exports = { OrchestratorAgent, STATES };
