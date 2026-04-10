/**
 * StatusFormatter — formats pipeline progress messages for WhatsApp notifications.
 */

const STAGE_LABELS = {
  queued:     'Queued',
  planning:   'Planning',
  coding:     'Coding',
  testing:    'Testing',
  debugging:  'Debugging',
  review:     'Review',
  pr_created: 'PR Created',
  paused:     'Paused',
  failed:     'Failed',
  cancelled:  'Cancelled',
};

// Typical stage durations in ms (fallback when no history is available)
const TYPICAL_STAGE_MS = {
  planning:  30_000,
  coding:   120_000,
  testing:   30_000,
  debugging: 60_000,
  review:    30_000,
};

// Ordered pipeline stages (excluding terminal states)
const PIPELINE_ORDER = ['planning', 'coding', 'testing', 'review', 'pr_created'];

/**
 * Format a duration in milliseconds into a human-readable string.
 * @param {number} ms
 * @returns {string}
 */
function formatElapsed(ms) {
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

/**
 * Get the duration spent in a specific stage.
 * @param {object} stageTiming
 * @param {string} stage
 * @returns {number|null} duration in ms, or null if stage hasn't started
 */
function getStageDuration(stageTiming, stage) {
  const start = stageTiming[`${stage}Start`];
  const end = stageTiming[`${stage}End`];
  if (start == null) return null;
  return (end != null ? end : Date.now()) - start;
}

/**
 * Estimate remaining time to completion based on current stage and timing history.
 * @param {object} stageTiming
 * @param {string} currentStage
 * @returns {number|null} estimated remaining ms, or null if unknown
 */
function calculateEstimatedCompletion(stageTiming, currentStage) {
  const currentIdx = PIPELINE_ORDER.indexOf(currentStage);
  if (currentIdx === -1) return null;

  let remaining = 0;
  // Sum up estimated time for current and remaining stages (excluding pr_created)
  for (let i = currentIdx; i < PIPELINE_ORDER.length - 1; i++) {
    const stage = PIPELINE_ORDER[i];
    const typical = TYPICAL_STAGE_MS[stage] ?? 60_000;
    if (i === currentIdx) {
      const start = stageTiming[`${stage}Start`];
      if (start != null) {
        const elapsed = Date.now() - start;
        remaining += Math.max(0, typical - elapsed);
      } else {
        remaining += typical;
      }
    } else {
      remaining += typical;
    }
  }

  return remaining;
}

/**
 * Format a progress message for a stage transition, including elapsed time,
 * retry count, and estimated completion.
 * @param {string} stage - current stage name
 * @param {object} task  - task object with stageTiming and retries
 * @param {string} [budgetStr] - optional budget string e.g. "3/10"
 * @returns {string}
 */
function formatProgressMessage(stage, task, budgetStr) {
  const stageTiming = task.stageTiming ?? {};
  const retries = task.retries ?? {};
  const now = Date.now();

  const taskStart = stageTiming.planningStart ?? stageTiming.codingStart;
  const totalElapsed = taskStart ? formatElapsed(now - taskStart) : null;
  const stageStart = stageTiming[`${stage}Start`];
  const stageElapsed = stageStart ? formatElapsed(now - stageStart) : null;

  const label = STAGE_LABELS[stage] ?? stage;
  const retryCount = retries[stage] ?? 0;
  const retryStr = retryCount > 0 ? ` (retry ${retryCount})` : '';

  let msg = `⏳ *${label}${retryStr}*`;
  if (stageElapsed) msg += ` — ${stageElapsed} in stage`;
  if (totalElapsed) msg += ` | ${totalElapsed} total`;

  const est = calculateEstimatedCompletion(stageTiming, stage);
  if (est != null && est > 5000) {
    msg += `\n⏱ Est. remaining: ~${formatElapsed(est)}`;
  }

  if (budgetStr) msg += `\nBudget: ${budgetStr}`;

  return msg;
}

/**
 * Format a stage completion summary (used in stageChanged event callbacks).
 * @param {string} completedStage - stage that just finished
 * @param {object} stageTiming
 * @returns {string}
 */
function formatStageCompletion(completedStage, stageTiming) {
  const label = STAGE_LABELS[completedStage] ?? completedStage;
  const duration = getStageDuration(stageTiming, completedStage);
  const durationStr = duration != null ? ` in ${formatElapsed(duration)}` : '';
  return `✅ *${label} complete*${durationStr}`;
}

/**
 * Format a plan as a WhatsApp confirmation prompt.
 * @param {Array<{id: number, description: string}>} steps
 * @returns {string}
 */
function formatPlan(steps) {
  const stepList = steps.map(s => `${s.id}. ${s.description}`).join('\n');
  return `📋 *Implementation Plan* (${steps.length} steps):\n${stepList}\n\nReply /confirm to start, /cancel to abort, or /modify <changes> to revise.`;
}

/**
 * Format a step completion progress message.
 * @param {{id: number, description: string}} step
 * @param {number} totalSteps
 * @returns {string}
 */
function formatStepProgress(step, totalSteps) {
  return `✅ *Step ${step.id}/${totalSteps} done*: ${step.description}`;
}

/**
 * Format a final task completion recap.
 * @param {object} task          - task object with planSteps and stageTiming
 * @param {object} [reviewResult]
 * @param {object} [prResult]
 * @returns {string}
 */
function formatCompletionRecap(task, reviewResult, prResult) {
  const taskStart = task.stageTiming?.planningStart ?? task.stageTiming?.codingStart;
  const totalTimeStr = taskStart ? ` in ${formatElapsed(Date.now() - taskStart)}` : '';

  const steps = task.planSteps ?? [];
  const stepsSummary = steps.length
    ? `\n*Steps completed (${steps.length}):*\n${steps.map(s => `  ✓ ${s.description}`).join('\n')}`
    : '';

  const reviewLine = reviewResult?.recap ? `\n_Review: ${reviewResult.recap}_` : '';

  const prLine = prResult?.prUrl
    ? `\nPR: ${prResult.prUrl}`
    : prResult?.branch
      ? `\nBranch: \`${prResult.branch}\``
      : '';

  const budgetLine = task._budgetStr ? `\nBudget used: ${task._budgetStr}` : '';

  return `🎉 *Task complete${totalTimeStr}!*${stepsSummary}${reviewLine}${prLine}${budgetLine}`;
}

/**
 * Format a confirmation acknowledgment sent after the user responds to a plan.
 * @param {'confirmed'|'cancelled'} action
 * @param {string} [reason] - optional reason for cancellation
 * @returns {string}
 */
function formatConfirmationAck(action, reason) {
  if (action === 'confirmed') {
    return '✅ *Confirmed!* Starting execution now…';
  }
  const reasonStr = reason ? `: ${reason}` : '';
  return `🚫 *Cancelled${reasonStr}*. Task has been aborted.`;
}

/**
 * Format a message indicating a plan confirmation request has timed out.
 * @param {number} timeoutSec - how many seconds were allowed
 * @returns {string}
 */
function formatConfirmationTimeout(timeoutSec) {
  return `⏰ *Confirmation timed out* after ${timeoutSec}s. Task has been cancelled. Send a new request to retry.`;
}

/**
 * Format a "step in progress" message (emitted when a step starts executing).
 * @param {{id: number, description: string}} step
 * @param {number} totalSteps
 * @returns {string}
 */
function formatStepInProgress(step, totalSteps) {
  return `🔄 *Step ${step.id}/${totalSteps}*: ${step.description}`;
}

/**
 * Format a mid-execution progress summary (emitted periodically during execution).
 * @param {number} completedSteps
 * @param {number} totalSteps
 * @param {string} [currentDescription] - description of the currently running step
 * @returns {string}
 */
function formatExecutionProgress(completedSteps, totalSteps, currentDescription) {
  const bar = buildProgressBar(completedSteps, totalSteps);
  let msg = `⚙️ *Executing* ${bar} ${completedSteps}/${totalSteps}`;
  if (currentDescription) msg += `\n↪ ${currentDescription}`;
  return msg;
}

/**
 * Build a simple ASCII progress bar.
 * @param {number} done
 * @param {number} total
 * @param {number} [width=10]
 * @returns {string}
 */
function buildProgressBar(done, total, width = 10) {
  if (total === 0) return '[' + '░'.repeat(width) + ']';
  const filled = Math.round((done / total) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

module.exports = {
  formatElapsed,
  formatProgressMessage,
  formatStageCompletion,
  calculateEstimatedCompletion,
  getStageDuration,
  formatPlan,
  formatStepProgress,
  formatCompletionRecap,
  formatConfirmationAck,
  formatConfirmationTimeout,
  formatStepInProgress,
  formatExecutionProgress,
};
