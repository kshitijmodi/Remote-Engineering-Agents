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
const { MetricsAgent } = require('./src/agents/MetricsAgent');
const { OrchestratorAgent } = require('./src/agents/OrchestratorAgent');
const { ContextAgent } = require('./src/agents/ContextAgent');
const { IntentAgent } = require('./src/agents/IntentAgent');
const { FileAgent } = require('./src/agents/FileAgent');
const { formatStepInProgress } = require('./src/utils/StatusFormatter');
const { processLinksFromText } = require('./src/utils/LinkProcessor');
const ExecutionStateManager = require('./src/utils/ExecutionStateManager');
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
    maxInvocations: 60,
    timeoutMs: 3_600_000,  // 60 min — complex coding tasks regularly exceed the old 5 min default
    // Block .env files from Claude Code tool access
    disallowedTools: ['Read(.env)', 'Edit(.env)', 'Write(.env)'],
  });
  const fileAgent = new FileAgent(messaging);
  const repoAgent = new RepoAgent();
  const logging   = new LoggingAgent();
  const metrics   = new MetricsAgent();
  const context   = new ContextAgent();
  const intent    = new IntentAgent();

  // Specialist agents
  const planning  = new PlanningAgent(executor);
  const execution = new ExecutionAgent(executor);
  const debugging = new DebuggingAgent(executor);
  const review    = new ReviewAgent(executor);
  const pr        = new PRAgent();

  // ── Phase 2: inject step-start progress updates via ExecutionAgent EventEmitter ──
  // 'stepStart' is not handled in the orchestrator callback, so we wire it here
  // to send "starting step X/Y" messages before the orchestrator sends "step X done".
  execution.on('stepStart', ({ step, totalSteps }) => {
    for (const userId of ALLOWED_NUMBERS) {
      const task = orchestrator.getActiveTask(userId);
      if (task && task.status === 'coding') {
        reliableSend(userId, formatStepInProgress(step, totalSteps)).catch(() => {});
        break;
      }
    }
  });

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

  // ── Resume context detection ──────────────────────────────────────────────
  // Check whether a prior budget-exhausted run left a persisted execution state.
  // OrchestratorAgent loads the same file in its constructor; surfacing the flag
  // here lets index.js make startup decisions and pass explicit resume context.
  const _execStateManager = new ExecutionStateManager();
  const _savedExecState   = _execStateManager.loadProgress();
  const isResume          = !!(_savedExecState && _savedExecState.currentAgentIndex > 0);
  if (isResume) {
    console.log(
      `[Startup] Saved execution state detected — will resume from stage index ` +
      `${_savedExecState.currentAgentIndex} (task: ${_savedExecState.taskId ?? 'unknown'})`
    );
  }

  // Orchestrator
  const orchestrator = new OrchestratorAgent(
    { planning, execution, debugging, review, pr, logging, executor, metrics, isResume },
    reliableSend,
    _execStateManager
  );

  // ── Checkpoint resume on startup ──────────────────────────────────────────
  // Restore active repo selections before resuming any in-progress tasks
  repoAgent._loadActiveRepos();

  // If the server crashed mid-task, auto-resume interrupted tasks after reconnect
  const pendingResumes = [];
  if (fs.existsSync(CHECKPOINT_DIR)) {
    const checkpoints = fs.readdirSync(CHECKPOINT_DIR).filter(f => f.endsWith('.json') && f !== 'active-repos.json');
    for (const file of checkpoints) {
      try {
        const cp = JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, file), 'utf8'));
        const inProgress = !['pr_created', 'failed', 'cancelled'].includes(cp.status);
        if (inProgress && cp.userId && cp.repo) {
          console.log(`[Startup] Found interrupted task ${cp.taskId} at stage: ${cp.status} — will auto-resume`);
          pendingResumes.push(cp);
        }
      } catch { /* malformed checkpoint — skip */ }
    }
  }

  // LLM-based intent classifier — replaces regex heuristics in CommunicationAgent
  async function classifyIntent(userId, text) {
    // If the user is in the middle of a file disambiguation, any reply should
    // go to the file-send handler so the pending selection can be resolved.
    if (fileAgent.hasPendingDisambiguation(userId)) {
      return 'FILE_SEND';
    }
    let contextBlock = '';
    let activeStatus = null;
    let hasActiveRepo = false;
    try {
      const repoPath = repoAgent.getActiveRepoPath(userId);
      hasActiveRepo = true;
      contextBlock = context.getContextBlock(repoPath);
    } catch { /* no active repo */ }
    const task = orchestrator.getActiveTask(userId);
    if (task && !['pr_created', 'failed', 'cancelled'].includes(task.status)) {
      activeStatus = task.status;
    }
    return intent.classify(text, { contextBlock, activeStatus, hasActiveRepo });
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

    onQuery: async (userId, question, incomingMultimodal) => {
      let repoPath;
      try {
        repoPath = repoAgent.getActiveRepoPath(userId);
      } catch {
        repoPath = null;
      }
      const target = repoPath || process.cwd();
      const contextBlock = target ? context.getContextBlock(target) : '';
      try {
        // Build media context — attachments (images/PDFs) + any links in the question
        const processedLinks = await processLinksFromText(question).catch(() => []);
        const incomingLinks = (incomingMultimodal?.urls ?? []).map((u) =>
          typeof u === 'string' ? { url: u, title: null, description: null } : u
        );
        const allLinks = [
          ...processedLinks,
          ...incomingLinks.filter((l) => !processedLinks.some((p) => p.url === l.url)),
        ];
        const safeMedia = (incomingMultimodal?.media ?? []).map(({ _raw, ...m }) => m);
        const media = (safeMedia.length > 0 || allLinks.length > 0)
          ? { attachments: safeMedia, links: allLinks }
          : undefined;

        const result = await executor.run(contextBlock + question, target, {
          allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
          media,
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

    onTask: async (userId, taskText, incomingMultimodal) => {
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

      // Fresh task start — wipe any leftover checkpoint/progress state so the
      // pipeline always begins from agent index 0 rather than a stale resume point.
      _execStateManager.clearCheckpoint();
      _execStateManager.clearProgress();

      context.append(repoPath, 'user', taskText);
      const release = repoAgent.acquireLock(userId);

      // Process URLs found in the message text via LinkProcessor
      const processedLinks = await processLinksFromText(taskText).catch(() => []);

      // Merge: processed links + any links/URLs pre-extracted by WhatsAppProvider
      // plus any media attachments (images, PDFs) forwarded by CommunicationAgent
      const incomingLinks = incomingMultimodal?.urls
        ? incomingMultimodal.urls.map((u) => (typeof u === 'string' ? { url: u, title: null, description: null } : u))
        : [];
      const incomingMedia = (incomingMultimodal?.media ?? []).map(({ _raw, ...m }) => m);

      const allLinks = [
        ...processedLinks,
        // Avoid duplicates — skip incoming links whose URL is already in processedLinks
        ...incomingLinks.filter((l) => !processedLinks.some((p) => p.url === l.url)),
      ];

      let multimodalContext = null;
      if (allLinks.length > 0 || incomingMedia.length > 0) {
        multimodalContext = {
          ...(allLinks.length > 0 ? { links: allLinks } : {}),
          ...(incomingMedia.length > 0 ? { media: incomingMedia } : {}),
        };
      }

      const taskId  = orchestrator.startTask(userId, taskText, repoPath, context, multimodalContext);
      await reliableSend(userId, `Task accepted (${taskId}). Starting planner... Budget: 0/60`);

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

    onConfirm: async (userId) => {
      const result = orchestrator.handleConfirmationResponse(userId, 'confirm');
      if (!result.handled) {
        await reliableSend(userId, 'No plan awaiting confirmation.');
      }
    },

    onModify: async (userId, modText) => {
      const result = orchestrator.handleConfirmationResponse(userId, 'modify', { modification: modText });
      if (!result.handled) {
        await reliableSend(userId, 'No plan awaiting modification.');
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
      // If a plan is awaiting confirmation, resolve it as cancelled without aborting the whole task state
      const result = orchestrator.handleConfirmationResponse(userId, 'cancel');
      if (!result.handled) {
        // No pending confirmation — cancel the running task entirely
        orchestrator.cancelTask(userId);
        await reliableSend(userId, 'Task cancelled.');
      }
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

    onRemove: async (userId, repoName) => {
      const { removed, wasActive } = repoAgent.removeRepo(userId, repoName);
      if (!removed) {
        await reliableSend(userId, `No workspace named *${repoName}* found. Use /list to see registered workspaces.`);
        return;
      }
      const activeNote = wasActive ? '\nNo active workspace set — use /switch or /init to pick one.' : '';
      await reliableSend(userId, `Removed *${repoName}* from registered workspaces. Files on disk are untouched.${activeNote}`);
    },

    onRepoList: async (userId) => {
      const workspaceRepos = repoAgent.listRepos();
      const customRepos = [...(repoAgent._customPaths?.keys() ?? [])];
      const activeRepo = repoAgent.getActiveRepo(userId);
      const all = [...new Set([...workspaceRepos, ...customRepos])];
      if (!all.length) {
        await reliableSend(userId, 'No repos registered. Use /connect or /init to add one.');
        return;
      }
      const lines = all.map(r => `${r === activeRepo ? '▶ ' : '  '}${r}`);
      await reliableSend(userId, `*Registered workspaces:*\n${lines.join('\n')}\n\n▶ = active`);
    },

    onListRepo: async (userId) => {
      let repoPath;
      try {
        repoPath = repoAgent.getActiveRepoPath(userId);
      } catch {
        await reliableSend(userId, 'No active repo. Use /connect <repo-url> or /switch <repo-name> first.');
        return;
      }

      try {
        const IGNORE = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store']);
        const lines = [];

        function walk(dir, prefix = '') {
          const entries = fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => !IGNORE.has(e.name))
            .sort((a, b) => {
              if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const isLast = i === entries.length - 1;
            lines.push(`${prefix}${isLast ? '└── ' : '├── '}${entry.name}${entry.isDirectory() ? '/' : ''}`);
            if (entry.isDirectory()) {
              walk(path.join(dir, entry.name), prefix + (isLast ? '    ' : '│   '));
            }
          }
        }

        lines.push(`${path.basename(repoPath)}/`);
        walk(repoPath);

        const tree = lines.join('\n');
        const MAX_LEN = 3000;
        const output = tree.length > MAX_LEN ? tree.slice(0, MAX_LEN) + '\n... (truncated)' : tree;
        await reliableSend(userId, `*Files in current repo:*\n\`\`\`\n${output}\n\`\`\``);
      } catch (err) {
        await reliableSend(userId, `Error listing repo contents: ${err.message}`);
      }
    },

    onRestart: async (userId) => {
      await reliableSend(userId, '🔄 Restarting bot... will be back in a few seconds.');
      await messaging.disconnect().catch(() => {});
      setTimeout(() => process.exit(0), 1000);
    },

    onStop: async (userId) => {
      await reliableSend(userId, '🛑 Stopping bot. Use pm2 start rea to bring it back up.');
      await messaging.disconnect().catch(() => {});
      setTimeout(() => process.exit(0), 1000);
    },

    onFileSend: async (userId, messageText, multimodal) => {
      console.log(`[onFileSend] Handler invoked for ${userId} — message: "${messageText}"`);
      let repoPath;
      try {
        repoPath = repoAgent.getActiveRepoPath(userId);
      } catch {
        repoPath = null;
      }
      const searchDirs = [repoPath || process.cwd()];

      let filePath;
      try {
        filePath = await fileAgent.searchAndMatchFile(userId, messageText, { searchDirs });
      } catch (err) {
        console.error(`[FileAgent] Error searching for file:`, err.message);
        await reliableSend(userId, `Error searching for file: ${err.message}`);
        return;
      }
      if (!filePath) return; // searchAndMatchFile already notified the user

      // Step 3: Read the matched file
      let fileData;
      try {
        fileData = fileAgent.prepareFileTransfer(filePath);
      } catch (err) {
        console.error(`[FileAgent] Failed to read file "${filePath}":`, err.message);
        await reliableSend(userId, `Failed to read file: ${err.message}`);
        return;
      }

      // Step 4: Send the file via WhatsAppProvider.sendDocument()
      const { base64, filename, mimeType, size } = fileData;
      const sizeKB = (size / 1024).toFixed(1);
      const caption = `${filename} (${sizeKB} KB)`;
      try {
        await messaging.sendDocument(userId, { mimeType, data: base64, filename, caption });
        console.log(`[FileAgent] Sent file "${filename}" (${sizeKB} KB) to ${userId}`);
      } catch (err) {
        console.error(`[FileAgent] Failed to send file "${filename}" to ${userId}:`, err.message);
        await reliableSend(userId, `Error delivering file: ${err.message}`);
      }
    },
  }, classifyIntent);

  commAgent.start();

  // ── Auto-resume interrupted tasks after WhatsApp connects ─────────────────
  if (pendingResumes.length > 0) {
    messaging._client?.once('ready', async () => {
      for (const cp of pendingResumes) {
        try {
          await reliableSend(
            cp.userId,
            `🔄 *Resuming interrupted task* ${cp.taskId}\nStage: *${cp.status}* | Budget used: ${cp.invocations}/60`
          );
          // Restore repo context and restart task from checkpoint stage
          const repoPath = cp.repo;
          executor.invocations = cp.invocations ?? 0;
          const taskId = orchestrator.startTask(cp.userId, cp.taskText, repoPath, context);
          // Fast-forward state to where it was interrupted
          const task = orchestrator.getActiveTask(cp.userId);
          if (task && cp.status !== 'planning' && cp.status !== 'queued') {
            task.status = cp.status;
            task.retries = cp.retries ?? { coding: 0, debugging: 0, review: 0 };
          }
        } catch (err) {
          console.error(`[Startup] Failed to resume task ${cp.taskId}:`, err.message);
        }
      }
    });
  }

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
