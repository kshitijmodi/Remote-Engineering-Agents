const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { BudgetExceededError } = require('../claude/ClaudeCodeExecutor');
const { formatProgressMessage, formatStageCompletion, formatElapsed, getStageDuration, formatPlan, formatStepProgress, formatCompletionRecap, formatConfirmationAck, formatConfirmationTimeout } = require('../utils/StatusFormatter');
const IS_WINDOWS = process.platform === 'win32';

const MAX_RETRIES = 3;
const CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const STATES = {
  QUEUED:                 'queued',
  PLANNING:               'planning',
  AWAITING_CONFIRMATION:  'awaiting_confirmation',  // waiting for /confirm after plan
  CODING:                 'coding',
  TESTING:                'testing',
  DEBUGGING:              'debugging',
  REVIEW:                 'review',
  PR_CREATED:             'pr_created',
  PAUSED:                 'paused',   // budget hit
  FAILED:                 'failed',
  CANCELLED:              'cancelled',
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
    // userId → { taskId, resolve, sentAt }  — tracks in-flight plan confirmations
    this._pendingConfirmations = new Map();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Start a new task for a user.
   * @param {string} userId
   * @param {string} taskText
   * @param {string} repoPath
   * @param {object|null} context
   * @param {{ attachments?: Array, links?: Array }|null} media - Multimodal context (images, PDFs, links)
   * @returns {string} taskId
   */
  startTask(userId, taskText, repoPath, context = null, media = null) {
    const taskId = randomUUID().slice(0, 8);
    const task = {
      taskId,
      userId,
      taskText,
      repoPath,
      context,
      media,
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
    // Unblock any pending plan confirmation
    task._confirmResolve?.({ confirmed: false, cancelled: true });
    task.status = STATES.CANCELLED;
    this._agents.logging.log(task.taskId, 'INFO', 'Task cancelled by user');
    this._agents.logging.endTask(task.taskId);
  }

  /**
   * Confirm the pending plan and proceed to coding.
   * @param {string} userId
   */
  confirmPlan(userId) {
    const task = this._getActiveTask(userId);
    if (!task || task.status !== STATES.AWAITING_CONFIRMATION) {
      this._notify(userId, 'No plan awaiting confirmation.');
      return;
    }
    task._confirmResolve?.({ confirmed: true });
  }

  /**
   * Request a plan revision before confirming.
   * @param {string} userId
   * @param {string} modificationText
   */
  modifyPlan(userId, modificationText) {
    const task = this._getActiveTask(userId);
    if (!task || task.status !== STATES.AWAITING_CONFIRMATION) {
      this._notify(userId, 'No plan awaiting confirmation.');
      return;
    }
    task._confirmResolve?.({ confirmed: false, modification: modificationText });
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
        { cwd: repoPath, shell: false, windowsHide: true }
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

    let modification = '';
    // Loop to support /modify revisions before the user confirms
    while (true) {
      const result = await planning.plan(task.taskText, task.repoPath, (e) =>
        logging.log(task.taskId, 'DEBUG', 'planning event', { type: e.type }),
        { fileTree, context: contextBlock, modification, media: task.media }
      );

      if (!result.success || result.steps.length === 0) {
        throw new Error('Planning agent produced no steps.');
      }

      task.planSteps = result.steps;
      logging.log(task.taskId, 'INFO', `Plan produced ${result.steps.length} steps`, { steps: result.steps.map(s => s.description) });

      // Transition to awaiting_confirmation (records planningEnd timing)
      this._transitionStage(task, STATES.AWAITING_CONFIRMATION);

      const planningDuration = getStageDuration(task.stageTiming, STATES.PLANNING);
      const planningTimeStr = planningDuration != null ? ` in ${formatElapsed(planningDuration)}` : '';
      await this._notify(
        task.userId,
        `✅ *Planning complete*${planningTimeStr}\n\n${formatPlan(result.steps)}`
      );

      // Await user /confirm, /cancel, or /modify
      const confirmResult = await this._awaitConfirmation(task);

      if (confirmResult.timedOut) {
        task.status = STATES.CANCELLED;
        await this._notify(task.userId, formatConfirmationTimeout(CONFIRMATION_TIMEOUT_MS / 1000));
        this._agents.logging.log(task.taskId, 'WARN', 'Plan confirmation timed out — task cancelled');
        this._agents.logging.endTask(task.taskId);
        return;
      }

      if (confirmResult.cancelled || task.status === STATES.CANCELLED) {
        await this._notify(task.userId, formatConfirmationAck('cancelled'));
        return;
      }

      if (confirmResult.confirmed) {
        await this._notify(task.userId, formatConfirmationAck('confirmed'));
        break;
      }

      // User requested a modification — re-run planning
      modification = confirmResult.modification || '';
      await this._notify(task.userId, `🔄 *Revising plan*${modification ? `: "${modification}"` : ''}...`);
      // Reset back to PLANNING state for the next iteration
      this._transitionStage(task, STATES.PLANNING);
    }

    this._transitionStage(task, STATES.CODING);
  }

  /** Returns a promise resolved by confirmPlan / modifyPlan / cancelTask, or timed out. */
  _awaitConfirmation(task) {
    const confirmPromise = new Promise((resolve) => {
      task._confirmResolve = resolve;
      // Register at orchestrator level so index.js can route responses by userId
      this._pendingConfirmations.set(task.userId, {
        taskId:  task.taskId,
        resolve,
        sentAt:  Date.now(),
      });
    });

    const timeoutPromise = new Promise((resolve) => {
      task._confirmTimeoutId = setTimeout(() => {
        resolve({ timedOut: true });
      }, CONFIRMATION_TIMEOUT_MS);
    });

    return Promise.race([confirmPromise, timeoutPromise]).finally(() => {
      // Clear timeout and pending confirmation entry regardless of outcome
      if (task._confirmTimeoutId != null) {
        clearTimeout(task._confirmTimeoutId);
        task._confirmTimeoutId = null;
      }
      if (this._pendingConfirmations.get(task.userId)?.taskId === task.taskId) {
        this._pendingConfirmations.delete(task.userId);
      }
    });
  }

  /**
   * Returns true if the user currently has a plan awaiting /confirm or /cancel.
   * @param {string} userId
   * @returns {boolean}
   */
  hasPendingConfirmation(userId) {
    return this._pendingConfirmations.has(userId);
  }

  /**
   * Unified confirmation response handler — routes /confirm, /cancel, /modify
   * responses to the correct pending confirmation promise, resuming pipeline execution.
   *
   * @param {string} userId
   * @param {'confirm'|'cancel'|'modify'} type
   * @param {object} [data]  — for 'modify': { modification: string }
   * @returns {{ handled: boolean, reason?: string }}
   */
  handleConfirmationResponse(userId, type, data = {}) {
    const pending = this._pendingConfirmations.get(userId);

    if (!pending) {
      return { handled: false, reason: 'no_pending_confirmation' };
    }

    const { resolve } = pending;

    switch (type) {
      case 'confirm':
        resolve({ confirmed: true });
        return { handled: true };

      case 'cancel':
        resolve({ confirmed: false, cancelled: true });
        return { handled: true };

      case 'modify': {
        const modification = (data.modification || '').trim();
        resolve({ confirmed: false, modification });
        return { handled: true };
      }

      default:
        return { handled: false, reason: `unknown_response_type:${type}` };
    }
  }

  async _stageCoding(task) {
    const { execution, logging } = this._agents;

    const taskPrompt = task.planSteps.length
      ? `Task: ${task.taskText}\n\nImplementation steps:\n${task.planSteps.map(s => `${s.id}. ${s.description}`).join('\n')}`
      : task.taskText;

    logging.log(task.taskId, 'STATE', 'Entering coding stage', { retry: task.retries.coding });
    await this._notify(task.userId, formatProgressMessage(STATES.CODING, task, this._budgetStr()));

    const result = await execution.code(taskPrompt, task.repoPath, (e) => {
      if (e.type === 'stepCompleted') {
        this._notify(task.userId, formatStepProgress(e.step, e.totalSteps))
          .catch(() => {});
      }
      logging.log(task.taskId, 'DEBUG', 'coding event', { type: e.type });
    }, task.planSteps, task.media);

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

    logging.log(task.taskId, 'INFO', `Review: ${result.verdict} — ${result.reasons}`);

    const reviewDuration = getStageDuration(task.stageTiming, STATES.REVIEW);
    const reviewTimeStr = reviewDuration != null ? ` in ${formatElapsed(reviewDuration)}` : '';

    task.reviewResult = result;

    if (result.passed) {
      await this._notify(task.userId, `✅ *Review passed*${reviewTimeStr}\n${formatProgressMessage(STATES.PR_CREATED, task, this._budgetStr())}`);
    } else {
      // Review failed — notify with findings but proceed to PR anyway
      // Review issues are advisory; blocking on them causes infinite retry loops on pre-existing code issues
      await this._notify(
        task.userId,
        `⚠️ *Review notes*${reviewTimeStr}:\n${result.reasons}\n\n_Proceeding to PR — review the findings before merging._`
      );
      task.reviewNotes = result.reasons;
    }
    await this._stagePR(task);
  }

  async _stagePR(task) {
    const { pr, logging } = this._agents;
    logging.log(task.taskId, 'STATE', 'Creating PR');

    try {
      const result = await pr.createPR(task.taskId, task.taskText, task.repoPath, task.reviewNotes);
      this._transitionStage(task, STATES.PR_CREATED);

      // Attach budget string to task so formatCompletionRecap can include it
      task._budgetStr = this._budgetStr();
      const completionMsg = formatCompletionRecap(task, task.reviewResult, result);
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
