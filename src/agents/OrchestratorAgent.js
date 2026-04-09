const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { BudgetExceededError } = require('../claude/ClaudeCodeExecutor');
const { formatProgressMessage, formatStageCompletion, formatElapsed, getStageDuration } = require('../utils/StatusFormatter');
const IS_WINDOWS = process.platform === 'win32';

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
class OrchestratorAgent extends EventEmitter {
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
    super();
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
  startTask(userId, taskText, repoPath, context = null) {
    const taskId = randomUUID().slice(0, 8);
    const task = {
      taskId,
      userId,
      taskText,
      repoPath,
      context,
      status: STATES.QUEUED,
      retries: { coding: 0, debugging: 0, review: 0 },
      lastTestOutput: '',
      planSteps: [],
      invocations: 0,
      stageTiming: {},
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
    const TERMINAL = [STATES.PR_CREATED, STATES.FAILED, STATES.CANCELLED, STATES.PAUSED];

    try {
      // Proper state-machine loop — handles review → re-coding → testing cycles correctly
      while (!TERMINAL.includes(task.status)) {
        switch (task.status) {
          case STATES.QUEUED:
          case STATES.PLANNING:
            await this._stagePlanning(task);
            break;
          case STATES.CODING:
            await this._stageCoding(task);
            break;
          case STATES.TESTING:
            await this._stageTesting(task);
            break;
          case STATES.DEBUGGING:
            await this._stageDebugging(task);
            break;
          case STATES.REVIEW:
            await this._stageReview(task);
            break;
          default:
            logging.log(task.taskId, 'ERROR', `Unknown state: ${task.status}`);
            task.status = STATES.FAILED;
        }
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
          `⏸️ *Budget limit reached* (${err.budget.current}/${err.budget.max})\n` +
          `Stage: ${task._pausedAtStage}\n` +
          `Reply /resume to grant 10 more invocations, or /cancel to abort.`
        );
      } else if (task.status !== STATES.CANCELLED) {
        task.status = STATES.FAILED;
        logging.log(task.taskId, 'ERROR', 'Task failed with error', { err: err.message });
        await this._notify(task.userId, `❌ *Task FAILED*: ${err.message}\nUse /logs for the full trace.`);
        logging.endTask(task.taskId);
        this._agents.metrics?.recordFailure(task.taskId, task.userId, err.message, task.retries, task.stageTiming);
      }
    }
  }

  _isSimpleTask(taskText) {
    const t = taskText.trim();
    const wordCount = t.split(/\s+/).length;
    if (wordCount > 12) return false;
    return /^(add|fix|update|change|rename|delete|remove|create|move|replace|refactor|edit)\s/i.test(t);
  }

  async _getFileTree(repoPath) {
    return new Promise((resolve) => {
      const proc = spawn(
        IS_WINDOWS ? 'cmd' : 'git',
        IS_WINDOWS ? ['/c', 'git', 'ls-files', '--others', '--exclude-standard', '-c'] : ['ls-files', '--others', '--exclude-standard', '-c'],
        { cwd: repoPath, shell: false }
      );
      let out = '';
      proc.stdout?.on('data', d => (out += d));
      proc.on('close', () => resolve(out.trim()));
      proc.on('error', () => resolve(''));
    });
  }

  async _stagePlanning(task) {
    const { planning, logging } = this._agents;
    this._transitionStage(task, STATES.PLANNING);

    // Skip planning for short, direct tasks — go straight to coding
    if (this._isSimpleTask(task.taskText)) {
      logging.log(task.taskId, 'INFO', 'Simple task detected — skipping planning');
      await this._notify(task.userId, `⚡ *Simple task — skipping planning*\n${formatProgressMessage(STATES.CODING, task, this._budgetStr())}`);
      task.planSteps = [];
      this._transitionStage(task, STATES.CODING);
      return;
    }

    await this._notify(task.userId, formatProgressMessage(STATES.PLANNING, task, this._budgetStr()));
    logging.log(task.taskId, 'STATE', 'Entering planning stage');

    // Pre-fetch file tree and context in parallel to save time during planning
    const [fileTree, contextBlock] = await Promise.all([
      this._getFileTree(task.repoPath),
      Promise.resolve(task.context?.getContextBlock(task.repoPath) ?? ''),
    ]);

    const fileTreeSection = fileTree ? `\nRepo files:\n${fileTree}\n\n` : '';
    const result = await planning.plan(contextBlock + fileTreeSection + task.taskText, task.repoPath, (e) =>
      logging.log(task.taskId, 'DEBUG', 'planning event', { type: e.type })
    );

    if (!result.success || result.steps.length === 0) {
      throw new Error('Planning agent produced no steps.');
    }

    task.planSteps = result.steps;
    logging.log(task.taskId, 'INFO', `Plan produced ${result.steps.length} steps`, { steps: result.steps });
    const planningDuration = getStageDuration(task.stageTiming, STATES.PLANNING);
    const planningTimeStr = planningDuration != null ? ` in ${formatElapsed(planningDuration)}` : '';
    await this._notify(
      task.userId,
      `✅ *Planning complete*${planningTimeStr} (${result.steps.length} steps)\n${result.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n${formatProgressMessage(STATES.CODING, task, this._budgetStr())}`
    );
    this._transitionStage(task, STATES.CODING);
  }

  async _stageCoding(task) {
    const { execution, logging } = this._agents;

    const taskPrompt = task.planSteps.length
      ? `Task: ${task.taskText}\n\nImplementation steps:\n${task.planSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : task.taskText;

    logging.log(task.taskId, 'STATE', 'Entering coding stage', { retry: task.retries.coding });
    await this._notify(task.userId, formatProgressMessage(STATES.CODING, task, this._budgetStr()));

    const result = await execution.code(taskPrompt, task.repoPath, (e) =>
      logging.log(task.taskId, 'DEBUG', 'coding event', { type: e.type })
    );

    logging.log(task.taskId, 'INFO', 'Coding complete', { success: result.success });
    await this._notify(
      task.userId,
      `${formatStageCompletion(STATES.CODING, task.stageTiming)}\n${formatProgressMessage(STATES.TESTING, task, this._budgetStr())}`
    );
    this._transitionStage(task, STATES.TESTING);
  }

  async _stageTesting(task) {
    const { execution, logging } = this._agents;

    logging.log(task.taskId, 'STATE', 'Entering testing stage');
    await this._notify(task.userId, formatProgressMessage(STATES.TESTING, task, this._budgetStr()));

    const result = await execution.test(task.repoPath, (e) =>
      logging.log(task.taskId, 'DEBUG', 'testing event', { type: e.type })
    );

    task.lastTestOutput = result.rawOutput;
    logging.log(task.taskId, 'INFO', 'Test run complete', {
      passed: result.passedCount,
      failed: result.failedCount,
    });

    if (result.passed) {
      const testingDuration = getStageDuration(task.stageTiming, STATES.TESTING);
      const testingTimeStr = testingDuration != null ? ` in ${formatElapsed(testingDuration)}` : '';
      await this._notify(
        task.userId,
        `✅ *Tests passed*${testingTimeStr} (${result.passedCount}/${result.passedCount + result.failedCount})\n${formatProgressMessage(STATES.REVIEW, task, this._budgetStr())}`
      );
      this._transitionStage(task, STATES.REVIEW);
    } else {
      if (task.retries.debugging >= MAX_RETRIES) {
        task.status = STATES.FAILED;
        await this._notify(
          task.userId,
          `❌ *Task FAILED* after ${MAX_RETRIES} debug attempts.\nError: ${result.details}\nUse /logs for full trace.`
        );
        this._agents.logging.endTask(task.taskId);
        this._agents.metrics?.recordFailure(task.taskId, task.userId, `Max debug retries (${MAX_RETRIES})`, task.retries, task.stageTiming);
        return;
      }
      task.retries.debugging += 1;
      await this._notify(
        task.userId,
        `⚠️ *Tests failed* (${result.failedCount} failing)\n${formatProgressMessage(STATES.DEBUGGING, task, this._budgetStr())}\nAttempt ${task.retries.debugging}/${MAX_RETRIES}`
      );
      this._transitionStage(task, STATES.DEBUGGING);
    }
  }

  async _stageDebugging(task) {
    const { debugging, logging } = this._agents;

    logging.log(task.taskId, 'STATE', 'Entering debugging stage', { attempt: task.retries.debugging });
    await this._notify(task.userId, formatProgressMessage(STATES.DEBUGGING, task, this._budgetStr()));

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
      `${formatStageCompletion(STATES.DEBUGGING, task.stageTiming)}\n${formatProgressMessage(STATES.TESTING, task, this._budgetStr())}`
    );
    this._transitionStage(task, STATES.TESTING);
  }

  async _stageReview(task) {
    const { review, logging } = this._agents;

    logging.log(task.taskId, 'STATE', 'Entering review stage', { retry: task.retries.review });
    await this._notify(task.userId, formatProgressMessage(STATES.REVIEW, task, this._budgetStr()));

    const result = await review.review(task.repoPath, (e) =>
      logging.log(task.taskId, 'DEBUG', 'review event', { type: e.type })
    );

    logging.log(task.taskId, 'INFO', `Review: ${result.verdict}`, { reasons: result.reasons });

    if (result.passed) {
      const reviewDuration = getStageDuration(task.stageTiming, STATES.REVIEW);
      const reviewTimeStr = reviewDuration != null ? ` in ${formatElapsed(reviewDuration)}` : '';
      await this._notify(task.userId, `✅ *Review passed*${reviewTimeStr}\n${formatProgressMessage(STATES.PR_CREATED, task, this._budgetStr())}`);
      await this._stagePR(task);
    } else {
      if (task.retries.review >= 1) {
        task.status = STATES.FAILED;
        await this._notify(
          task.userId,
          `❌ *Review FAILED* after retry.\nReasons: ${result.reasons}\nUse /logs for details.`
        );
        this._agents.logging.endTask(task.taskId);
        this._agents.metrics?.recordFailure(task.taskId, task.userId, `Review failed: ${result.reasons}`, task.retries, task.stageTiming);
        return;
      }
      task.retries.review += 1;
      task.retries.coding += 1;
      await this._notify(
        task.userId,
        `⚠️ *Review failed*. Reasons: ${result.reasons}\nRetrying coding stage. Budget: ${this._budgetStr()}`
      );
      this._transitionStage(task, STATES.CODING);
      // Main state-machine loop will handle CODING → TESTING → REVIEW
    }
  }

  async _stagePR(task) {
    const { pr, logging } = this._agents;
    logging.log(task.taskId, 'STATE', 'Creating PR');

    try {
      const result = await pr.createPR(task.taskId, task.taskText, task.repoPath);
      this._transitionStage(task, STATES.PR_CREATED);

      const prLine = result.prUrl
        ? `PR: ${result.prUrl}`
        : `Branch pushed: ${result.branch} (run \`gh pr create\` to open PR)`;

      const taskStart = task.stageTiming.planningStart ?? task.stageTiming.codingStart;
      const totalTimeStr = taskStart ? ` in ${formatElapsed(Date.now() - taskStart)}` : '';
      const completionMsg = `🎉 *Task complete${totalTimeStr}!*\nBranch: \`${result.branch}\`\n${prLine}\nBudget used: ${this._budgetStr()}`;
      task.context?.append(task.repoPath, 'assistant', `Task completed: ${task.taskText}`);
      await this._notify(task.userId, completionMsg);
      this._agents.metrics?.recordSuccess(task.taskId, task.userId, task.retries, task.stageTiming);
    } catch (err) {
      logging.log(task.taskId, 'WARN', 'PR creation failed', { err: err.message });
      this._transitionStage(task, STATES.PR_CREATED);
      await this._notify(
        task.userId,
        `Task complete! Code changes are in: ${task.repoPath}\n` +
        `PR creation failed: ${err.message}\nCommit and push manually if needed.`
      );
      this._agents.metrics?.recordSuccess(task.taskId, task.userId, task.retries, task.stageTiming);
    }

    this._agents.logging.endTask(task.taskId);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _transitionStage(task, newState) {
    const prev = task.status;
    const now = Date.now();

    // Record end time for the stage we are leaving
    if (prev && prev !== STATES.QUEUED) {
      const endKey = `${prev}End`;
      if (task.stageTiming[endKey] == null) {
        task.stageTiming[endKey] = now;
      }
    }

    // Record start time for the stage we are entering
    const startKey = `${newState}Start`;
    if (task.stageTiming[startKey] == null) {
      task.stageTiming[startKey] = now;
    }

    task.status = newState;
    this._agents.logging.log(task.taskId, 'STATE', `${prev} → ${newState}`);

    this.emit('stageChanged', {
      taskId:        task.taskId,
      userId:        task.userId,
      stage:         newState,
      previousStage: prev,
      timestamp:     now,
      retries:       { ...task.retries },
      stageTiming:   { ...task.stageTiming },
    });
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
      taskId:      task.taskId,
      status:      task.status,
      repo:        task.repoPath,
      taskText:    task.taskText,
      retries:     task.retries,
      invocations: this._agents.executor.budgetStatus.current,
      stageTiming: { ...task.stageTiming },
    };
  }
}

module.exports = { OrchestratorAgent, STATES };
