require('dotenv').config();
const { WhatsAppProvider } = require('./src/messaging/WhatsAppProvider');
const { CommunicationAgent } = require('./src/agents/CommunicationAgent');
const { ClaudeCodeExecutor } = require('./src/claude/ClaudeCodeExecutor');
const { RepoAgent, RepoNotFoundError } = require('./src/agents/RepoAgent');
const { PlanningAgent } = require('./src/agents/PlanningAgent');
const { ExecutionAgent } = require('./src/agents/ExecutionAgent');
const { DebuggingAgent } = require('./src/agents/DebuggingAgent');
const { ReviewAgent } = require('./src/agents/ReviewAgent');
const { PRAgent } = require('./src/agents/PRAgent');
const { LoggingAgent } = require('./src/agents/LoggingAgent');
const { OrchestratorAgent } = require('./src/agents/OrchestratorAgent');
const { ContextAgent } = require('./src/agents/ContextAgent');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const ALLOWED_NUMBERS = process.env.ALLOWED_NUMBERS
  ? process.env.ALLOWED_NUMBERS.split(',').map(n => n.trim())
  : [];

const HEARTBEAT_INTERVAL_MS = 60_000;   // 60s
const MSG_RETRY_ATTEMPTS     = 3;
const CHECKPOINT_DIR         = path.resolve('./checkpoints');

// ─── Bootstrap ───────────────────────────────────────────────────────────────
async function main() {
  if (ALLOWED_NUMBERS.length === 0) {
    console.error('ERROR: Set ALLOWED_NUMBERS env var before starting.');
    console.error('Example: ALLOWED_NUMBERS="15513582416@c.us" node index.js');
    process.exit(1);
  }

  // Core infrastructure
  const messaging = new WhatsAppProvider();
  const executor  = new ClaudeCodeExecutor({
    maxInvocations: 15,
    // Block .env files from Claude Code tool access
    disallowedTools: ['Read(.env)', 'Edit(.env)', 'Write(.env)'],
  });
  const repoAgent = new RepoAgent();
  const logging   = new LoggingAgent();
  const context   = new ContextAgent();

  // Specialist agents
  const planning  = new PlanningAgent(executor);
  const execution = new ExecutionAgent(executor);
  const debugging = new DebuggingAgent(executor);
  const review    = new ReviewAgent(executor);
  const pr        = new PRAgent();

  // Forward-declared so orchestrator notify can use it
  let commAgent;

  // ── Reliable send with retry ──────────────────────────────────────────────
  async function reliableSend(userId, text) {
    console.log(`[Send] → ${userId}: "${text.slice(0, 80)}"`);
    for (let attempt = 1; attempt <= MSG_RETRY_ATTEMPTS; attempt++) {
      try {
        await messaging.sendMessage(userId, text);
        return;
      } catch (err) {
        if (attempt === MSG_RETRY_ATTEMPTS) {
          console.error(`[Send] Failed after ${MSG_RETRY_ATTEMPTS} attempts:`, err.message);
        } else {
          console.warn(`[Send] Attempt ${attempt} failed, retrying...`);
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }
  }

  // Orchestrator
  const orchestrator = new OrchestratorAgent(
    { planning, execution, debugging, review, pr, logging, executor },
    reliableSend
  );

  // ── Checkpoint resume on startup ──────────────────────────────────────────
  // Restore active repo selections before resuming any in-progress tasks
  repoAgent._loadActiveRepos();

  // If the server crashed mid-task, notify the user their task was interrupted
  if (fs.existsSync(CHECKPOINT_DIR)) {
    const checkpoints = fs.readdirSync(CHECKPOINT_DIR).filter(f => f.endsWith('.json'));
    for (const file of checkpoints) {
      try {
        const cp = JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, file), 'utf8'));
        const inProgress = !['pr_created', 'failed', 'cancelled'].includes(cp.status);
        if (inProgress && cp.userId) {
          console.log(`[Startup] Found interrupted task ${cp.taskId} at stage: ${cp.status}`);
          // Notify after connect — queue it
          messaging.once?.('ready', async () => {
            await reliableSend(
              cp.userId,
              `System restarted. Your task *${cp.taskId}* was interrupted at stage: *${cp.status}*.\n` +
              `Budget was: ${cp.invocations}/15\n` +
              `Send your task again to restart, or /logs to see where it stopped.`
            );
          });
        }
      } catch { /* malformed checkpoint — skip */ }
    }
  }

  // Communication agent
  commAgent = new CommunicationAgent(messaging, ALLOWED_NUMBERS, {

    onStatus: async (userId) => {
      const task = orchestrator.getActiveTask(userId);
      if (!task) {
        await reliableSend(userId, 'No active task running.');
        return;
      }
      const stageEmoji = {
        queued: '🕐', planning: '⏳', coding: '⌨️',
        testing: '🧪', debugging: '🐛', review: '🔍',
        pr_created: '✅', paused: '⏸️', failed: '❌', cancelled: '🚫',
      };
      const emoji = stageEmoji[task.status] || '⏳';
      const budget = executor.budgetStatus;
      await reliableSend(
        userId,
        `${emoji} *Task ${task.taskId}* is currently: *${task.status}*\nBudget: ${budget.current}/${budget.max}\nDebug retries: ${task.retries.debugging}/${3}`
      );
    },

    onQuery: async (userId, question) => {
      let repoPath;
      try {
        repoPath = repoAgent.getActiveRepoPath(userId);
      } catch {
        repoPath = null;
      }
      const target = repoPath || process.cwd();
      const contextBlock = target ? context.getContextBlock(target) : '';
      try {
        const result = await executor.run(contextBlock + question, target, {
          allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
        });
        const answer = result.output || 'No response.';
        if (target) {
          context.append(target, 'user', question);
          context.append(target, 'assistant', answer);
        }
        await reliableSend(userId, answer);
      } catch (err) {
        await reliableSend(userId, `Error: ${err.message}`);
      }
    },

    onTask: async (userId, taskText) => {
      let repoPath;
      try {
        repoPath = repoAgent.getActiveRepoPath(userId);
      } catch {
        await reliableSend(userId, 'No active repo. Use /connect <repo-url> first.');
        return;
      }
      if (repoAgent.isLocked(userId)) {
        await reliableSend(userId, 'A task is already running on this repo. Wait or /cancel first.');
        return;
      }

      context.append(repoPath, 'user', taskText);
      const release = repoAgent.acquireLock(userId);
      const taskId  = orchestrator.startTask(userId, taskText, repoPath, context);
      await reliableSend(userId, `Task accepted (${taskId}). Starting planner... Budget: 0/15`);

      const interval = setInterval(() => {
        const task = orchestrator.getActiveTask(userId);
        if (!task || ['pr_created', 'failed', 'cancelled'].includes(task.status)) {
          release();
          clearInterval(interval);
        }
      }, 5000);
    },

    onInit: async (userId, arg) => {
      const parts = arg.match(/^"([^"]+)"|^(\S+)/);
      const folderPath = parts ? (parts[1] || parts[2]) : arg;

      await reliableSend(userId, `Setting up *${folderPath}* as active workspace...`);
      try {
        const { repoName, repoPath } = await repoAgent.init(userId, folderPath);
        await reliableSend(userId, `Done! Active workspace set to *${repoName}*.\n*Path:* ${repoPath}\n\nSend a task to start working on it.`);
      } catch (err) {
        await reliableSend(userId, `Init failed: ${err.message}`);
      }
    },

    onConnect: async (userId, repoUrl) => {
      await reliableSend(userId, `Cloning ${repoUrl}...`);
      try {
        const { repoName, alreadyCloned } = await repoAgent.connect(userId, repoUrl);
        const verb = alreadyCloned ? 'Updated' : 'Cloned';
        await reliableSend(
          userId,
          `${verb} *${repoName}*. Active workspace set.\nRepos: ${repoAgent.listRepos().join(', ')}`
        );
      } catch (err) {
        await reliableSend(userId, `Failed to connect repo: ${err.message}`);
      }
    },

    onSwitch: async (userId, repoName) => {
      try {
        repoAgent.switch(userId, repoName);
        await reliableSend(userId, `Switched to *${repoName}*.`);
      } catch (err) {
        if (err instanceof RepoNotFoundError) {
          await reliableSend(userId, `${err.message}\nAvailable: ${repoAgent.listRepos().join(', ') || 'none'}`);
        } else {
          await reliableSend(userId, `Switch failed: ${err.message}`);
        }
      }
    },

    onResume: async (userId) => {
      executor.extendBudget(10);
      await reliableSend(
        userId,
        `Budget extended by 10 (now ${executor.budgetStatus.current}/${executor.budgetStatus.max}). Resuming...`
      );
      orchestrator.resumeTask(userId);
    },

    onCancel: async (userId) => {
      orchestrator.cancelTask(userId);
      await reliableSend(userId, 'Task cancelled.');
    },

    onPush: async (userId, branchName) => {
      let repoPath;
      try {
        repoPath = repoAgent.getActiveRepoPath(userId);
      } catch {
        await reliableSend(userId, 'No active repo. Use /connect <repo-url> first.');
        return;
      }
      await reliableSend(userId, 'Creating branch, committing and pushing to GitHub...');
      try {
        const taskId = Date.now().toString(36);
        const branch = branchName || `feature/manual-push-${taskId}`;
        const result = await pr.createPR(taskId, branch, repoPath);
        const prLine = result.prUrl
          ? `PR created: ${result.prUrl}`
          : `Branch pushed: ${result.branch}\nOpen a PR at GitHub manually.`;
        await reliableSend(userId, `Done!\n${prLine}`);
      } catch (err) {
        await reliableSend(userId, `Push failed: ${err.message}`);
      }
    },

    onLogs: async (userId) => {
      const task = orchestrator.getActiveTask(userId);
      if (!task) {
        await reliableSend(userId, 'No recent task found.');
        return;
      }
      const logs = logging.getTailLogs(task.taskId, 20);
      await reliableSend(userId, `*Logs for task ${task.taskId}:*\n\`\`\`\n${logs}\n\`\`\``);
    },

    onRepo: async (userId) => {
      const repoName = repoAgent.getActiveRepo(userId);
      await reliableSend(userId, repoName ? `Active repo: *${repoName}*` : 'No active repo set.');
    },

    onClearContext: async (userId) => {
      let repoPath;
      try {
        repoPath = repoAgent.getActiveRepoPath(userId);
      } catch {
        await reliableSend(userId, 'No active repo to clear context for.');
        return;
      }
      context.clear(repoPath);
      await reliableSend(userId, 'Context cleared for this repo.');
    },
  });

  commAgent.start();

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  let lastHeartbeat = Date.now();
  setInterval(() => {
    const status = messaging.getStatus();
    if (!status.connected) {
      console.warn('[Heartbeat] WhatsApp disconnected — pausing active tasks');
      // Tasks stay in their current state; they'll resume on reconnect
    } else {
      lastHeartbeat = Date.now();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // ── Disconnect / reconnect handling ───────────────────────────────────────
  messaging._client?.on('disconnected', async (reason) => {
    console.warn('[WhatsApp] Disconnected:', reason, '— will attempt reconnect');
    // Pause all active tasks
    for (const userId of ALLOWED_NUMBERS) {
      const task = orchestrator.getActiveTask(userId);
      if (task && !['pr_created', 'failed', 'cancelled', 'paused'].includes(task.status)) {
        task._pausedAtStage = task.status;
        task.status = 'paused';
        logging.log(task.taskId, 'WARN', 'Task paused due to WhatsApp disconnect');
      }
    }
    // Attempt reconnect after 5s
    setTimeout(async () => {
      try {
        console.log('[WhatsApp] Attempting reconnect...');
        await messaging._client.initialize();
      } catch (err) {
        console.error('[WhatsApp] Reconnect failed:', err.message);
      }
    }, 5000);
  });

  messaging._client?.on('ready', async () => {
    // Notify users with paused tasks that we're back
    for (const userId of ALLOWED_NUMBERS) {
      const task = orchestrator.getActiveTask(userId);
      if (task?.status === 'paused' && task._pausedAtStage) {
        await reliableSend(
          userId,
          `Session restored. Task *${task.taskId}* paused at: *${task._pausedAtStage}*.\nSend /resume to continue.`
        );
      }
    }
  });

  console.log('[System] Connecting to WhatsApp...');
  await messaging.connect();
}

main().catch((err) => {
  console.error('[System] Fatal error:', err);
  process.exit(1);
});
