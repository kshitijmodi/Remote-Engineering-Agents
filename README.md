# WhatsApp Claude Code Agent

> A WhatsApp-controlled multi-agent AI developer powered by Claude Code CLI.

## What This Is

This system lets you control a full software development workflow entirely from WhatsApp.
You send a natural language instruction, and a multi-agent backend orchestrates planning,
coding, testing, debugging, and PR creation — all using Claude Code CLI as the execution engine.

**No direct LLM API calls. Agents are orchestration logic only. Claude Code does all the thinking.**

---

## Table of Contents

- [Getting Started](#getting-started)
  - [Quick Start](#quick-start)
  - [Prerequisites](#1-prerequisites-install-once)
  - [Clone and Install](#2-clone-and-install)
  - [Configure](#3-configure)
  - [Start the Bot](#4-start-the-bot)
  - [Point at a Project](#5-point-at-a-project)
  - [Send Tasks](#6-send-tasks)
- [What You Can Do](#what-you-can-do)
- [Core Stack](#core-stack)
- [Architecture](#architecture)
- [State Machine](#state-machine)
- [Agents & Responsibilities](#agents--responsibilities)
- [AI Agents Overview](#ai-agents-overview)
- [Slash Commands](#slash-commands)
- [Button Interaction System](#button-interaction-system)
- [Token Budget System](#token-budget-system)
- [Task Object (Shared State)](#task-object-shared-state)
- [Workspace Structure](#workspace-structure)
- [Reliability](#reliability)
- [Security](#security)
- [Common Workflows](#common-workflows)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Advanced / For Contributors](#advanced--for-contributors)
  - [Build Order](#build-order)
  - [Claude Code Prompt Templates](#claude-code-prompt-templates)
- [Success Metrics](#success-metrics)
- [MVP Scope](#mvp-scope)

---

## Getting Started

### Quick Start

Here's a complete example of taking a task from a WhatsApp message all the way to a merged PR:

```
# 1. Start the bot (first time only)
npm install && node index.js
# Scan the QR code in the terminal with WhatsApp → Linked Devices → Link a Device

# 2. Connect a repo (once per project)
/connect https://github.com/you/your-repo

# 3. Send a task in plain English
Add a loading spinner to the submit button

# Bot replies: "Task accepted. Planning..."
# Bot replies: "Coding step 1/3..."
# Bot replies: "Tests passed. Running review..."
# Bot replies: "PR opened: https://github.com/you/your-repo/pull/42"
```

That's the full loop. The sections below explain each piece in detail.

---

### 1. Prerequisites *(install once)*

**Required** — the bot cannot run without these:

| Tool | Why you need it | Install |
|---|---|---|
| **Node.js** | Runs the bot process | [nodejs.org](https://nodejs.org) |
| **Claude Code CLI** | The AI execution engine — does all the coding, testing, and reviewing | `npm install -g @anthropic-ai/claude-code` then `claude login` |

**Optional** — only needed for specific features:

| Tool | When you need it | Install |
|---|---|---|
| **GitHub CLI (`gh`)** | Required for `/connect <repo-url>` (cloning from GitHub) and automatic PR creation. Not needed if you only use `/init` with a local folder. | [cli.github.com](https://cli.github.com) then `gh auth login` |
| **pm2** | Keeps the bot running after crashes and across reboots. Skip this if you're just testing locally. | `npm install -g pm2` |

### 2. Clone and Install

```bash
git clone https://github.com/kshitijmodi/Remote-Engineering-Agents
cd Remote-Engineering-Agents
npm install
```

### 3. Configure

Create a `.env` file in the root:

```
ALLOWED_NUMBERS=1XXXXXXXXXX@c.us
```

Replace with your own WhatsApp number in the format `<countrycode><number>@c.us`.

### 4. Start the Bot

Install pm2 for automatic restart on crash and laptop reboot:

```bash
npm install -g pm2
pm2 start index.js --name rea
pm2 startup   # follow the printed command to auto-start on boot
pm2 save
```

Or run directly (no auto-restart):

```bash
node index.js
```

Scan the QR code that appears in the terminal with WhatsApp (Linked Devices → Link a Device).

### 5. Point at a Project

In WhatsApp, send one of:

```
/connect https://github.com/you/your-repo
```
*(clones from GitHub and sets as active workspace)*

```
/init "C:\path\to\local\project"
```
*(uses an existing local folder as active workspace)*

### 6. Send Tasks

Just type naturally in WhatsApp:

```
Add a dark mode toggle to the settings page
```

The bot will plan, code, test, review, and open a PR automatically.

---

## What You Can Do

Send tasks in plain English from WhatsApp — no commands, no syntax. Here are concrete examples:

**Add a feature**
```
Add a loading spinner to the submit button
Add dark mode support to the settings page
Add email validation to the signup form
```

**Fix a bug**
```
The login button does nothing when the password field is empty — fix it
API returns 500 when the user has no profile picture — handle that case
```

**Write tests**
```
Write unit tests for the auth module
Add integration tests for the /api/orders endpoint
```

**Refactor code**
```
Refactor the payment service to use async/await instead of callbacks
Extract the date formatting logic into a shared utility
```

**Documentation**
```
Add JSDoc comments to all exported functions in utils.js
Update the README with the new environment variables
```

**Any other dev task**
```
Upgrade all dependencies to their latest stable versions
Set up ESLint with the Airbnb config
Create a GitHub Actions workflow for CI
```

The bot will plan the work, write or edit code, run tests, iterate on failures, review the diff, and open a PR — all without you leaving WhatsApp.

---

## Core Stack

- **WhatsApp Interface:** `whatsapp-web.js`
- **Execution Engine:** Claude Code CLI (`claude-code "<task>"`)
- **Runtime:** Node.js
- **Repo Operations:** Git CLI
- **State Persistence:** JSON checkpoints (local filesystem, MVP)

---

## Architecture

```
WhatsApp
  ↓
Communication Agent       ← parses messages, enforces whitelist, sends responses
  ↓
Orchestration Agent        ← state machine controller
  ↓
Planning Agent             ← breaks task into steps via Claude Code
  ↓
Execution Agent            ← runs Claude Code for coding + tests
  ↓
Debugging Agent            ← iterative fix loop via Claude Code
  ↓
Review Agent               ← reviews diff, returns PASS or FAIL
  ↓
Logging Agent              ← structured logs, checkpoints every 2 min
  ↓
Repo Agent                 ← clones repos, manages workspace isolation
```

---

## State Machine

```
queued → planning → coding → testing
                                ├── pass → review
                                └── fail → debugging
                                              ├── fix → testing  (max 3 retries)
                                              └── fail → FAILED

review
  ├── pass → pr_created
  └── fail → coding (1 retry)
```

**Rules:**
- Max 3 retries per stage
- Every transition is logged
- Unrecoverable failures return control to the user via WhatsApp

---

## Agents & Responsibilities

| Agent | Responsibility |
|---|---|
| **Communication Agent** | WhatsApp send/receive, whitelist auth, slash command parsing |
| **Orchestration Agent** | State machine, routing between agents |
| **ContextAgent** | Gathers and maintains repository/task context for other agents |
| **IntentAgent** | Classifies free-text messages into TASK, QUESTION, STATUS, or PUSH intents |
| **Planning Agent** | Breaks task into steps using Claude Code CLI |
| **Execution Agent** | Runs Claude Code for feature implementation + tests |
| **Debugging Agent** | Iterative fix loop via Claude Code calls |
| **Review Agent** | Runs Claude Code with diff review prompt, returns PASS/FAIL |
| **Repo Agent** | Clones repos, manages `/workspace` isolation, handles `/connect` and `/switch` |
| **MetricsAgent** | Tracks invocation counts, retry counts, and task success/failure metrics |
| **PRAgent** | Creates branches, commits, and opens GitHub PRs via git + gh CLI |
| **Logging Agent** | Structured logs, 2-min checkpoints, `/logs` command |

---

## AI Agents Overview

Each agent is a single JavaScript class in `src/agents/`. They share state via the Task Object and communicate through the Orchestrator — no agent calls another directly.

---

### CommunicationAgent

**File:** `src/agents/CommunicationAgent.js`

The gateway between WhatsApp and the rest of the system. Every inbound message passes through this agent before anything else runs, and every outbound update is sent through it.

**Key responsibilities:**
- **Whitelist authentication** — silently drops messages from any number not in `ALLOWED_NUMBERS`; authorized senders are never aware of rejections
- **Slash command parsing** — intercepts `/connect`, `/init`, `/switch`, `/remove`, `/confirm`, `/modify`, `/resume`, `/cancel`, `/push`, `/logs`, `/list`, `/repo`, `/clear-context`, `/restart`, `/stop`, and `/help`, then calls the appropriate handler
- **Intent-based routing** — passes free-text messages through the IntentAgent classifier (or a heuristic fallback) and routes them as `TASK`, `QUESTION`, `STATUS`, or `PUSH`
- **Progress formatting** — subscribes to `stageChanged` events from the Orchestrator and sends formatted stage-completion messages to the user
- **Plan confirmation flow** — sends formatted plan previews and collects `/confirm`, `/modify`, or `/cancel` responses

**Interacts with:** MessagingLayer (send/receive all WhatsApp messages), IntentAgent (delegates free-text classification), OrchestratorAgent (invokes `startTask`, `cancelTask`, `resumeTask`, `confirmPlan`, `modifyPlan`; subscribes to `stageChanged` events), RepoAgent (invokes workspace commands for `/connect`, `/init`, `/switch`, `/list`).

---

### ContextAgent

**File:** `src/agents/ContextAgent.js`

Maintains a rolling conversation history per repository so Claude Code can be given relevant prior context when starting a new task.

**Key responsibilities:**
- **Per-repo history storage** — writes conversation entries as a JSON file (`.rea-context.json`) inside each repo directory, so history persists across bot restarts
- **History trimming** — keeps only the most recent 10 exchanges to avoid bloating prompts
- **Context block generation** — formats stored history into a plain-text block that PlanningAgent and OrchestratorAgent prepend to Claude Code prompts
- **History clearing** — the `/clear-context` command calls `clear()` to reset history for the active repo without affecting other repos

**Interacts with:** OrchestratorAgent (called at task start to supply `getContextBlock()` and at task end to `append()` the outcome), PlanningAgent (receives the formatted context block to include in planning prompts). Reads and writes `.rea-context.json` directly on the filesystem — no other agent dependency.

---

### DebuggingAgent

**File:** `src/agents/DebuggingAgent.js`

Called by the Orchestrator when tests fail. Applies a targeted fix via Claude Code CLI and hands control back so tests can be re-run.

**Key responsibilities:**
- **Root-cause analysis** — sends the original task description plus the full test failure output to Claude Code, instructing it to identify and fix only the failing code
- **Minimal-patch enforcement** — the prompt explicitly forbids rewriting working code, keeping fixes surgical
- **Attempt tracking** — accepts an `attempt` number (1–3) for logging; the Orchestrator decides whether to retry or fail after inspecting the result
- **Budget reporting** — returns `budget` from the executor so the Orchestrator can detect budget exhaustion and pause the task

**Interacts with:** OrchestratorAgent (receives `taskText`, `lastTestOutput`, `repoPath`, and `attempt` number from the Orchestrator; returns a `{ success, budget }` result), ClaudeCodeExecutor (the single outbound dependency — one CLI call per invocation). Never calls other agents directly.

---

### ExecutionAgent

**File:** `src/agents/ExecutionAgent.js`

Handles the two core coding stages: implementing the task and running the test suite.

**Key responsibilities:**
- **Step-by-step coding** — when the Orchestrator provides a structured plan, each step is executed as a separate Claude Code invocation; progress events (`stepStart`, `stepCompleted`) are emitted so the user sees per-step updates in WhatsApp
- **Single-shot coding** — for tasks without a plan, the whole task is sent in one Claude Code call
- **Test runner detection** — sniffs the repo for `package.json` (npm test), `pytest.ini`, `pyproject.toml`, `Cargo.toml`, `go.mod`, or `Makefile` to determine the correct test command before invoking Claude Code
- **Structured test output parsing** — extracts `STATUS`, `PASSED`, `FAILED`, and `DETAILS` fields from Claude Code's response for the Orchestrator to act on
- **No retry logic** — deliberately hands failures straight back to the Orchestrator, which decides whether to debug or fail

**Interacts with:** OrchestratorAgent (called for `code()` and `test()` stages; emits `stepStart`/`stepCompleted` events that the Orchestrator forwards to CommunicationAgent), ClaudeCodeExecutor (all Claude Code CLI calls go through here). Reads the repo filesystem to detect the test runner but does not call other agents.

---

### IntentAgent

**File:** `src/agents/IntentAgent.js`

Classifies every free-text WhatsApp message into one of four intents so CommunicationAgent knows how to route it.

**Key responsibilities:**
- **LLM-based classification** — runs a dedicated Claude Haiku call (separate budget, never competes with the task pipeline) to determine intent
- **Four intents** — `TASK` (write/fix/refactor code), `QUESTION` (explain or discuss something), `STATUS` (check on a running task), `PUSH` (commit and push current changes)
- **Situational context** — includes the active task stage and whether a repo is connected in the classification prompt, improving accuracy (e.g. "done?" during a coding stage → `STATUS`, not `TASK`)
- **Safe default** — returns `QUESTION` on any error so the bot answers rather than blindly starting a task

**Interacts with:** CommunicationAgent (called as the `classify` callback with `(userId, text)`; returns an intent string). Queries OrchestratorAgent for the active task stage to enrich the classification prompt. Uses ClaudeCodeExecutor for the classification call but on a separate invocation budget so it never consumes the task's token allowance.

---

### LoggingAgent

**File:** `src/agents/LoggingAgent.js`

Provides structured logging and crash-recovery checkpointing for every task.

**Key responsibilities:**
- **Per-task log files** — writes JSON-structured log entries to `logs/task_<id>.log`; buffer is flushed to disk every 30 seconds
- **Automatic checkpointing** — serializes the full Task Object to `checkpoints/task_<id>.json` every 2 minutes so the Orchestrator can resume from the last known state after a crash or disconnect
- **Manual checkpointing** — the Orchestrator can also call `checkpoint()` directly at key transition points
- **`/logs` command** — `getTailLogs()` reads and formats the last 20 log lines for display in WhatsApp
- **Timer lifecycle** — `startTask()` / `endTask()` create and clean up flush and checkpoint timers so no timers leak between tasks

**Interacts with:** OrchestratorAgent (called at every state transition via `log()`, and at task boundaries via `startTask()` / `endTask()`; the Orchestrator passes a snapshot callback to `startCheckpointing()` so the LoggingAgent can serialize task state without holding a direct reference to the task object). Writes only to the local filesystem — no other agent dependency.

---

### MetricsAgent

**File:** `src/agents/MetricsAgent.js`

Tracks aggregate task outcomes to validate the system's PRD success targets.

**Key responsibilities:**
- **Success/failure recording** — called by the Orchestrator at the end of every task with retry counts and stage timing data
- **Execution time tracking** — calculates wall-clock time from planning start to task end for each task
- **Aggregate summary** — `getSummary()` returns total tasks, success rate (%), average execution time, and average debugging retries across all historical tasks
- **Persistent storage** — appends data to `logs/metrics.json` so stats survive bot restarts

**Interacts with:** OrchestratorAgent exclusively — `recordSuccess()` and `recordFailure()` are called at the terminal state of every task. No other agent calls MetricsAgent. Writes to `logs/metrics.json` on the local filesystem.

---

### OrchestratorAgent

**File:** `src/agents/OrchestratorAgent.js`

The central state machine. Every task runs through the Orchestrator, which decides which agent to call next based on the current state and each agent's result.

**Key responsibilities:**
- **State machine execution** — drives tasks through `queued → planning → awaiting_confirmation → coding → testing → debugging → review → pr_created` (or `failed`/`cancelled`/`paused`)
- **Plan confirmation gate** — after planning, waits for the user to send `/confirm`, `/modify`, or `/cancel` before proceeding to coding; times out after 5 minutes
- **Retry enforcement** — allows up to 3 debug retries and 1 review-fail retry before marking a task `FAILED`
- **Budget pause/resume** — catches `BudgetExceededError` from the executor, pauses the task, and resumes from the same stage when the user sends `/resume`
- **Stage timing** — records start/end timestamps for every stage so CommunicationAgent can display elapsed times in progress messages
- **Event emission** — emits `stageChanged` events that CommunicationAgent subscribes to for real-time WhatsApp updates

**Interacts with:** All pipeline agents — calls PlanningAgent, ExecutionAgent, DebuggingAgent, ReviewAgent, and PRAgent in sequence based on task state. Calls LoggingAgent at every transition and MetricsAgent at task end. Reads context from ContextAgent at task start and appends the outcome on completion. Emits `stageChanged` events consumed by CommunicationAgent. Receives `confirmPlan`/`modifyPlan`/`cancelTask`/`resumeTask` calls from CommunicationAgent when the user responds to prompts.

---

### PRAgent

**File:** `src/agents/PRAgent.js`

Creates the final pull request once review passes.

**Key responsibilities:**
- **Feature branch creation** — generates a branch name from the task text (`feature/<slug>-<taskId>`) and checks it out
- **Commit and push** — stages all changes with `git add -A`, commits with a `feat:` message, and pushes to the remote using a token-authenticated URL
- **GitHub repo auto-creation** — if the repo has no remote origin (e.g. initialized with `/init`), creates a public GitHub repo via `gh repo create` before pushing
- **PR creation via GitHub CLI** — runs `gh pr create` with the task text as the PR title and body; gracefully skips PR creation if `gh` is not available or the call fails
- **Review notes passthrough** — if the ReviewAgent returned notes, they are included in the PR body under a "Review Notes" section

**Interacts with:** OrchestratorAgent (called as the final pipeline step; receives `taskId`, `taskText`, `repoPath`, and optional `reviewNotes` from the Orchestrator; returns a `{ branchName, prUrl }` result). Shells out to `git` and the GitHub CLI (`gh`) — no other agent dependency.

---

### PlanningAgent

**File:** `src/agents/PlanningAgent.js`

Breaks a natural language task into a structured list of numbered implementation steps before coding begins.

**Key responsibilities:**
- **Step generation** — sends the task, repo file tree, and conversation context to Claude Haiku via Claude Code CLI, requesting a numbered list of up to 8 specific implementation steps
- **Repo-aware planning** — includes the output of `git ls-files` in the prompt so Claude knows which files already exist
- **Plan revision support** — accepts a `modification` string from the user (via `/modify`) and re-runs planning with the requested changes incorporated
- **Step parsing** — extracts numbered lines from the model output, stripping markdown fences and bold markers, and returns an array of `{id, description}` objects for the Orchestrator

**Interacts with:** OrchestratorAgent (called with `taskText`, `repoPath`, a progress-event callback, and an options object containing `fileTree`, `context`, and `modification`; returns `{ success, steps }`), ContextAgent (receives the pre-formatted context block from the Orchestrator, which fetches it from ContextAgent before calling `plan()`), ClaudeCodeExecutor (the sole outbound dependency for the actual Claude Code CLI call).

---

### RepoAgent

**File:** `src/agents/RepoAgent.js`

Manages the workspace: cloning repos, switching between them, and enforcing one-task-at-a-time locking.

**Key responsibilities:**
- **Repo cloning** — `/connect <url>` clones a GitHub repo into `workspace/<repo-name>/`; if already cloned, fetches and resets to `origin/HEAD` to ensure a clean state
- **Local folder initialization** — `/init <path>` registers an existing local folder as a workspace, initializing a git repo if needed
- **Active repo tracking** — maps each `userId` to their currently active workspace; persisted to `checkpoints/active-repos.json` so the mapping survives restarts
- **Workspace switching** — `/switch <name>` changes the active repo for a user without re-cloning
- **Exclusive task locking** — `acquireLock()` prevents two tasks from running concurrently on the same repo; returns a `release` function the Orchestrator calls when the task ends

**Interacts with:** CommunicationAgent/index.js (workspace commands `/connect`, `/init`, `/switch`, `/remove`, `/list`, `/repo` are routed here from the command handler layer), OrchestratorAgent (calls `acquireLock()` before starting a task and the returned `release()` when the task ends). Shells out to `git` and `gh` for cloning — no other agent dependency.

---

### ReviewAgent

**File:** `src/agents/ReviewAgent.js`

Reviews the code diff produced by the task before a PR is created.

**Key responsibilities:**
- **Diff collection** — tries `git diff HEAD`, then `git diff --cached`, then `git diff origin/main...HEAD` in order to capture all changes regardless of whether they are staged or committed
- **Auto-approval for small diffs** — skips the LLM call for diffs under 10 changed lines, returning an instant PASS to save an invocation
- **Claude Haiku review** — sends the diff to Claude Haiku with the PRD prompt ("Review the following code diff for bugs and style issues. Respond only with: PASS or FAIL and reasons.")
- **Verdict parsing** — scans the model output for a line starting with `PASS` or `FAIL`; defaults to `PASS` if the verdict is ambiguous to avoid infinite retry loops
- **Advisory-only enforcement** — review failures are surfaced as notes in the PR body rather than blocking deployment, preventing pre-existing code issues from causing infinite retry cycles

**Interacts with:** OrchestratorAgent (called after tests pass; receives `repoPath` and a progress-event callback; returns `{ passed, verdict, reasons }`), ClaudeCodeExecutor (used for the diff-review Claude Code CLI call; skipped entirely for small diffs). Shells out to `git` to collect the diff — no other agent dependency.

---

## Slash Commands

| Category | Command | Action |
|---|---|---|
| **Workspace** | `/init "<local-path>"` | Set a local folder as active workspace |
| **Workspace** | `/connect <repo-url>` | Clone a GitHub repo and set as active workspace |
| **Workspace** | `/switch <repo-name>` | Switch between registered workspaces |
| **Workspace** | `/remove <repo-name>` | Unregister a workspace (files on disk are NOT deleted) |
| **Workspace** | `/list` | Show all registered workspaces |
| **Workspace** | `/repo` | Show currently active workspace |
| **Tasks** | `/push [branch]` | Commit and push changes to GitHub, open PR |
| **Tasks** | `/cancel` | Abort the running task |
| **Tasks** | `/resume` | Extend budget by 10 invocations and continue a paused task |
| **Tasks** | `/logs` | Show recent task logs |
| **Bot Control** | `/restart` | Gracefully restart the bot (auto-restarts via pm2) |
| **Bot Control** | `/stop` | Gracefully stop the bot |
| **Other** | `/clear-context` | Reset conversation history for the active repo |
| **Other** | `/help` | Show all available commands |

---

## Button Interaction System

REA presents interactive WhatsApp buttons (quick replies and list pickers) at key decision points instead of asking the user to type slash commands. The pipeline that powers this is split across three files:

| File | Role |
|---|---|
| `src/ui/WhatsAppButtons.js` | Builds raw WhatsApp API payloads (`buildQuickReply`, `buildListMessage`, `buildTemplateMessage`) |
| `src/ui/ConfirmationPrompts.js` | Pre-built helper functions that wrap the builders with standard button IDs |
| `src/messaging/ButtonResponseHandler.js` | Receives button interactions from `MessagingLayer` and routes them to registered callbacks |

---

### Button ID Conventions

Every button carries a short `id` string that is returned in the webhook when the user taps it. `ButtonResponseHandler` matches on these IDs to call the right handler. All IDs are defined in `ConfirmationPrompts.js` and must not be changed without updating the handler routing in `ButtonResponseHandler.js`.

| ID | Prompt helper | Meaning |
|---|---|---|
| `confirm_yes` | `yesNo()` | Affirmative answer on a Yes/No prompt |
| `confirm_no` | `yesNo()` | Negative answer on a Yes/No prompt |
| `ccm_confirm` | `confirmCancel()`, `confirmCancelModify()` | User approved the proposed action |
| `ccm_cancel` | `confirmCancel()`, `confirmCancelModify()` | User cancelled the proposed action |
| `ccm_modify` | `confirmCancelModify()` | User wants to modify before proceeding |
| `choice_<N>` | `choiceList()` | User selected the Nth item (0-based) from a list |
| `retry_retry` | `retryCancel()` | User wants to retry the failed operation |
| `retry_cancel` | `retryCancel()` | User cancelled after a failure |

For **template messages** (sent outside the 24-hour window via `buildTemplateMessage`), each quick-reply button slot carries a `payload` string instead of an `id`. Use the same `action:confirm:<context>` / `action:cancel:<context>` format to keep them consistent with the above conventions:

```js
buildTemplateMessage('plan_approval', 'en_US', {
  bodyParams: ['Deploy to production'],
  buttons: [
    { payload: 'action:confirm:plan', index: 0 },
    { payload: 'action:cancel:plan',  index: 1 },
  ],
});
```

Template button payloads are surfaced on the normalized message object with `type: 'template_button_reply'` and their `id` field set to the `payload` string, so custom handler logic outside `ButtonResponseHandler` can inspect them directly.

---

### ConfirmationPrompts helpers

All helpers live in `src/ui/ConfirmationPrompts.js` and return a `{ type, payload }` object ready to pass to `WhatsAppProvider.sendQuickReply()` or `WhatsAppProvider.sendListMessage()`.

```js
const { yesNo, confirmCancel, confirmCancelModify, choiceList, retryCancel } = require('./ui/ConfirmationPrompts');

// Simple yes / no
yesNo('Do you want to continue?', { yesLabel: 'Yes', noLabel: 'No' });

// Confirm or cancel (plan approval in PlanningAgent)
confirmCancel('Ready to start coding the plan above?');

// Confirm, cancel, or modify (execution draft in ExecutionAgent)
confirmCancelModify('About to run: npm run build. Proceed?');

// Arbitrary choice list (> 3 options)
choiceList('Which environment?', ['staging', 'production', 'local']);

// Retry or cancel after failure
retryCancel('Tests failed. What would you like to do?');
```

---

### ButtonResponseHandler — handler signatures

`ButtonResponseHandler` is instantiated with a plain object whose keys are callback functions. Register it once in `CommunicationAgent` (or wherever button responses are handled) and call `handler.handleMessage(msg)` for every inbound message that may carry a button interaction.

```js
const { ButtonResponseHandler } = require('./messaging/ButtonResponseHandler');

const handler = new ButtonResponseHandler({
  /**
   * Called when the user taps Confirm on a confirmCancel / confirmCancelModify prompt,
   * or taps Yes on a yesNo prompt (when no dedicated onYes is registered).
   * @param {string} userId
   */
  onConfirm: (userId) => { /* approve draft / start execution */ },

  /**
   * Called when the user taps Cancel on any prompt, or taps No on a yesNo prompt
   * (when no dedicated onNo is registered), or taps Cancel on a retryCancel prompt.
   * @param {string} userId
   */
  onCancel: (userId) => { /* abort task */ },

  /**
   * Called when the user taps Modify on a confirmCancelModify prompt.
   * `hint` is the button label text — the actual modification text comes from
   * the user's next free-text message.
   * @param {string} userId
   * @param {string} hint   — button title from the tapped button (may be empty)
   */
  onModify: (userId, hint) => { /* enter modification-awaiting state */ },

  /**
   * Called when the user taps Yes on a yesNo prompt.
   * Falls back to onConfirm if not provided.
   * @param {string} userId
   */
  onYes: (userId) => { /* affirmative answer */ },

  /**
   * Called when the user taps No on a yesNo prompt.
   * Falls back to onCancel if not provided.
   * @param {string} userId
   */
  onNo: (userId) => { /* negative answer */ },

  /**
   * Called when the user selects an item from a choiceList prompt.
   * @param {string} userId
   * @param {number} choiceIndex  — 0-based index matching the choices[] array position
   * @param {string} choiceTitle  — display label of the selected row
   */
  onChoice: (userId, choiceIndex, choiceTitle) => { /* handle selection */ },

  /**
   * Called when the user taps Retry on a retryCancel prompt.
   * @param {string} userId
   */
  onRetry: (userId) => { /* retry last operation */ },
});

// In MessagingLayer.onMessage(), intercept button responses before text routing:
if (handler.handleMessage(msg)) return; // button was handled — skip text routing
```

`handleMessage(msg)` returns `true` if the message carried a recognised button ID and was routed to a handler, or `false` if it should be passed through to normal text routing.

---

## Token Budget System

Each task has a max invocation limit to control cost:

```json
{
  "max_invocations": 15,
  "current_invocations": 0
}
```

- Increments on every Claude Code CLI call
- At limit: task pauses, user notified via WhatsApp
- User replies `/resume` (+10 invocations) or `/cancel`

---

## Task Object (Shared State)

Every running task is represented as a single JSON object that all agents read from and write to. This is how state passes between agents without them needing to call each other directly.

```json
{
  "task_id": "uuid",          // Unique ID — used to name log files and checkpoint files
  "status": "coding",         // Current stage — drives which agent runs next (see State Machine)
  "repo": "repo_name",        // Which workspace directory this task is operating in
  "invocations": 5,           // How many Claude Code CLI calls have been made — checked against max_invocations
  "retries": {
    "planning": 0,            // Retries per stage — each stage allows up to 3 before the task is marked FAILED
    "coding": 0,
    "testing": 0,
    "debugging": 1,           // e.g. 1 means the debugger has already attempted one fix
    "review": 0
  },
  "last_checkpoint": "2026-04-07T10:00:00Z"  // Timestamp of last save — used to resume after a crash or disconnect
}
```

**Why this matters:** Because the task object is persisted to disk as a checkpoint every 2 minutes, the bot can recover from crashes, disconnects, or reboots without losing progress. The `status` field tells the Orchestrator exactly where to pick up.

---

## Workspace Structure

The bot keeps all cloned repos, logs, and task checkpoints in separate top-level directories so nothing bleeds across tasks or repos.

```
workspace/
  ├── repo_1/        ← each repo gets its own isolated directory; Claude Code only sees files inside here
  ├── repo_2/        ← switching repos (/switch) just changes which directory is "active"
logs/
  ├── task_<id>.log  ← one log file per task, named by task_id; view with /logs
checkpoints/
  ├── task_<id>.json ← serialized Task Object saved every 2 min; enables crash recovery and /resume
```

**Rules:**
- **One active task per repo at a time** — prevents two tasks from conflicting on the same files (MVP constraint)
- **`.env` files are blocked** — Claude Code is never given access to environment files, so secrets stay safe
- **Full directory isolation per repo** — repos cannot access each other's files even if running concurrently

---

## Reliability

| Behaviour | Spec |
|---|---|
| Task accepted acknowledgment | < 2s |
| First substantive response | < 5s |
| Heartbeat interval | 60s |
| Message retry attempts | 3x per delivery |
| Checkpoint interval | Every 2 min |
| Log flush interval | Every 30s |
| On disconnect | Pause task, persist state |
| On reconnect | Resume from last checkpoint |

---

## Security

- Whitelist-based auth — only pre-registered WhatsApp numbers accepted
- Unauthorized messages silently ignored
- `.env` files blocked from all agent access
- Repo isolation enforced per workspace directory

---

## Common Workflows

Below are three real-world examples showing what a full interaction looks like, from your WhatsApp message to a merged PR.

---

### Workflow 1: Add a Feature

**You send:**
```
Add a loading spinner to the submit button on the checkout page
```

**Bot replies (in sequence):**
```
✅ Task accepted. Planning...
📋 Plan ready — 3 steps. Starting coding...
🔨 Coding step 1/3: Adding spinner component...
🔨 Coding step 2/3: Wiring spinner to form submit handler...
🔨 Coding step 3/3: Writing unit tests...
✅ Tests passed. Running review...
✅ Review passed. Opening PR...
🚀 PR opened: https://github.com/you/your-repo/pull/42
```

**Total time:** ~5–10 minutes, zero interaction needed after the first message.

---

### Workflow 2: Fix a Bug

**You send:**
```
The login button does nothing when the password field is empty — fix it
```

**Bot replies (in sequence):**
```
✅ Task accepted. Planning...
📋 Plan ready — 2 steps. Starting coding...
🔨 Coding step 1/2: Adding empty-field validation before form submit...
🔨 Coding step 2/2: Adding error message display...
❌ Tests failed. Debugging (attempt 1/3)...
🔧 Fix applied. Re-running tests...
✅ Tests passed. Running review...
✅ Review passed. Opening PR...
🚀 PR opened: https://github.com/you/your-repo/pull/43
```

**Note:** The debugging loop is automatic — the bot retries up to 3 times without any input from you.

---

### Workflow 3: Budget Pause and Resume

Some tasks are large and hit the invocation limit mid-way. The bot pauses and waits for your go-ahead.

**You send:**
```
Refactor the entire authentication module to use async/await
```

**Bot replies:**
```
✅ Task accepted. Planning...
📋 Plan ready — 7 steps. Starting coding...
🔨 Coding step 1/7...
🔨 Coding step 2/7...
...
⏸️ Budget limit reached (15/15 invocations). Task paused at step 4/7.
Reply /resume to add 10 more invocations, or /cancel to stop.
```

**You send:**
```
/resume
```

**Bot replies:**
```
▶️ Resuming from step 4/7...
🔨 Coding step 4/7...
...
🚀 PR opened: https://github.com/you/your-repo/pull/44
```

---

## Project Structure

For developers who want to extend or modify the bot, here's how the `src/` directory is organized:

```
src/
├── agents/                  ← One file per agent (the core of the system)
│   ├── CommunicationAgent.js   ← WhatsApp message handling, whitelist auth, slash command parsing
│   ├── OrchestratorAgent.js    ← State machine controller; routes work between all other agents
│   ├── IntentAgent.js          ← Classifies incoming messages as tasks vs. commands vs. chatter
│   ├── ContextAgent.js         ← Maintains per-repo conversation context for Claude Code
│   ├── PlanningAgent.js        ← Calls Claude Code to break a task into numbered steps
│   ├── ExecutionAgent.js       ← Calls Claude Code to write/edit code and run tests
│   ├── DebuggingAgent.js       ← Iterative fix loop: re-runs Claude Code until tests pass or retries exhausted
│   ├── ReviewAgent.js          ← Calls Claude Code with a diff review prompt; returns PASS or FAIL
│   ├── PRAgent.js              ← Creates branches, commits, and opens GitHub PRs via git + gh CLI
│   ├── RepoAgent.js            ← Clones repos, manages workspace isolation, handles /connect and /switch
│   ├── LoggingAgent.js         ← Structured logs, 2-min checkpoints, /logs command
│   └── MetricsAgent.js         ← Tracks invocation counts, retry counts, and task success metrics
│
├── claude/
│   └── ClaudeCodeExecutor.js   ← The single place that shells out to the Claude Code CLI; all agents go through this
│
├── messaging/
│   ├── MessagingLayer.js        ← Provider-agnostic interface for sending/receiving messages
│   ├── WhatsAppProvider.js      ← whatsapp-web.js adapter; swap this file to support Telegram or Slack
│   └── ButtonResponseHandler.js ← Routes incoming button interactions to onConfirm/onCancel/onModify/onChoice/onRetry callbacks
│
├── ui/
│   ├── WhatsAppButtons.js       ← Low-level payload builders: buildQuickReply, buildListMessage, buildTemplateMessage
│   └── ConfirmationPrompts.js   ← Pre-built helpers (yesNo, confirmCancel, confirmCancelModify, choiceList, retryCancel)
│
└── utils/
    └── StatusFormatter.js       ← Formats status updates into readable WhatsApp messages (with emoji prefixes)
```

**Key extension points:**

- **Add a new agent** — create a file in `src/agents/`, then register it in `OrchestratorAgent.js`.
- **Add a new messaging provider** — implement the same interface as `WhatsAppProvider.js` and swap it in `MessagingLayer.js`.
- **Change how Claude Code is called** — edit `ClaudeCodeExecutor.js` only; all agents inherit the change automatically.
- **Add a new slash command** — handle it in `CommunicationAgent.js` and route it through `OrchestratorAgent.js`.

---

## Success Metrics

| Metric | Target |
|---|---|
| Task success rate | > 70% |
| Avg retries per task | < 2 |
| Avg task completion time | < 15 min |
| Cost per task | Near-zero |

---

## MVP Scope

**Included:**
- WhatsApp bot (whatsapp-web.js)
- All 8 agents
- Claude Code CLI execution
- State machine orchestration
- Repo management + workspace isolation
- Token budget system
- Persistent task storage + checkpoint resume

**Excluded (Phase 2+):**
- Multi-user support
- Distributed / cloud scaling
- Web dashboard
- Telegram / Slack provider swap

---

## Troubleshooting

### WhatsApp Connection Issues

**QR code never appears / terminal shows nothing**
- Make sure `node index.js` (or `pm2 start index.js`) ran without errors. Missing `npm install` is the most common cause.
- Delete the `wwebjs_auth/` folder in the project root and restart — this forces a fresh session.

**QR code scanned but bot stays offline**
- WhatsApp only allows one linked device session at a time with `whatsapp-web.js`. If another session is active (from a previous run), it will silently drop the new one. Kill all running `node` processes, delete `wwebjs_auth/`, and restart.

**Bot was working, then stopped receiving messages**
- WhatsApp sessions expire after prolonged inactivity or if your phone loses internet. Restart the bot (`pm2 restart rea` or `node index.js`) and re-scan the QR code.

**Messages from your number are silently ignored**
- Check that your number is in `.env` as `ALLOWED_NUMBERS=<countrycode><number>@c.us` (no spaces, no `+`). Example: `15513582416@c.us`.

---

### Claude Code CLI Issues

**`claude: command not found`**
- Run `npm install -g @anthropic-ai/claude-code` and confirm with `claude --version`.
- On some systems `npm` global bin isn't on `PATH`. Run `npm bin -g` to find the bin directory and add it to your shell profile.

**`claude login` opens a browser but never completes**
- Complete the login in the browser, then return to the terminal and press Enter if prompted. If the browser doesn't open, try `claude login --no-browser` for a manual token flow.

**Claude Code returns errors mid-task (e.g., "rate limit", "auth expired")**
- Re-run `claude login` to refresh credentials. The bot will retry the current step automatically (up to 3 times), so you may not need to do anything.

---

### Workspace Conflicts

**`/connect` fails with "repo already exists"**
- A previous clone is already in the `workspace/` directory. Use `/switch <repo-name>` to activate it, or manually delete `workspace/<repo-name>/` and re-run `/connect`.

**Two tasks seem to interfere with each other**
- The MVP enforces one active task per repo at a time. If a task was interrupted unexpectedly and left a lock, run `/cancel` to clear it, then resubmit your task.

**Claude Code edits files in the wrong repo**
- Run `/repo` to confirm which workspace is active. Use `/switch <repo-name>` to change it before sending the next task.

**Bot reports a checkpoint but `/resume` does nothing**
- Checkpoints are stored in `checkpoints/task_<id>.json`. If the file is corrupt or missing, the task cannot be resumed — run `/cancel` to clear the stale state and start fresh.

---

## Advanced / For Contributors

### Build Order

Build one agent at a time. Do not proceed to the next until the current one is tested.

1. **Execution Agent** — single Claude Code CLI call, result returned to WhatsApp
2. **Planning Agent** — task breakdown via Claude Code
3. **Logging Agent** — structured logs, checkpoints, `/logs` command
4. **Heartbeat + Disconnect Handling** — reliability layer

### Claude Code Prompt Templates

**Planning Agent**
```
Break the following task into numbered implementation steps for a software project.
Be specific about files to create or modify.
Task: <task>
```

**Review Agent**
```
Review the following code diff for bugs and style issues.
Respond only with: PASS or FAIL and reasons.
Diff: <diff>
```
