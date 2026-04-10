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
- [Slash Commands](#slash-commands)
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
ALLOWED_NUMBERS=15513582416@c.us
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
| **Planning Agent** | Breaks task into steps using Claude Code CLI |
| **Execution Agent** | Runs Claude Code for feature implementation + tests |
| **Debugging Agent** | Iterative fix loop via Claude Code calls |
| **Review Agent** | Runs Claude Code with diff review prompt, returns PASS/FAIL |
| **Repo Agent** | Clones repos, manages `/workspace` isolation, handles `/connect` and `/switch` |
| **Logging Agent** | Structured logs, 2-min checkpoints, `/logs` command |

---

## Slash Commands

| Category | Command | Action |
|---|---|---|
| **Workspace** | `/init "<local-path>"` | Set a local folder as active workspace |
| **Workspace** | `/connect <repo-url>` | Clone a GitHub repo and set as active workspace |
| **Workspace** | `/switch <repo-name>` | Switch between registered workspaces |
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
│   └── WhatsAppProvider.js      ← whatsapp-web.js adapter; swap this file to support Telegram or Slack
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
