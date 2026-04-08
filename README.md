# WhatsApp Claude Code Agent

> A WhatsApp-controlled multi-agent AI developer powered by Claude Code CLI.

## What This Is

This system lets you control a full software development workflow entirely from WhatsApp.
You send a natural language instruction, and a multi-agent backend orchestrates planning,
coding, testing, debugging, and PR creation — all using Claude Code CLI as the execution engine.

**No direct LLM API calls. Agents are orchestration logic only. Claude Code does all the thinking.**

---

## Getting Started

### 1. Prerequisites *(install once)*

- **Node.js** — download and install from [nodejs.org](https://nodejs.org)
- **Claude Code CLI**
  - `npm install -g @anthropic-ai/claude-code`
  - `claude login`
- **GitHub CLI** *(only needed for `/connect` and PR creation)*
  - Download from [cli.github.com](https://cli.github.com)
  - `gh auth login`

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

| Command | Action |
|---|---|
| `/connect <repo-url>` | Clone repo and set as active workspace |
| `/switch <repo-name>` | Switch active workspace |
| `/repo` | Show the currently active repo name (persists across restarts) |
| `/resume` | Grant 10 more Claude Code invocations and continue paused task |
| `/cancel` | Abort current task |
| `/logs` | Return latest log output for active task |

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

```json
{
  "task_id": "uuid",
  "status": "coding",
  "repo": "repo_name",
  "invocations": 5,
  "retries": {
    "planning": 0,
    "coding": 0,
    "testing": 0,
    "debugging": 1,
    "review": 0
  },
  "last_checkpoint": "2026-04-07T10:00:00Z"
}
```

---

## Workspace Structure

```
workspace/
  ├── repo_1/        ← isolated git repo
  ├── repo_2/
logs/
  ├── task_<id>.log
checkpoints/
  ├── task_<id>.json
```

**Rules:**
- One active task per repo at a time (MVP)
- `.env` files are blocked from Claude Code access
- Each repo has a fully isolated directory

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

## Build Order (for Claude Code)

Build one agent at a time. Do not proceed to the next until the current one is tested.

1. **Communication Agent** — WhatsApp bot, whitelist, slash command parsing
2. **Repo Agent** — `/connect`, `/switch`, workspace isolation
3. **Execution Agent** — single Claude Code CLI call, result returned to WhatsApp
4. **Orchestration Agent** — state machine wiring all agents together
5. **Planning Agent** — task breakdown via Claude Code
6. **Debugging Agent** — iterative fix loop
7. **Review Agent** — diff review with PASS/FAIL output
8. **Logging Agent** — structured logs, checkpoints, `/logs` command
9. **Token Budget System** — invocation tracking, pause/resume
10. **Heartbeat + Disconnect Handling** — reliability layer

---

## Claude Code Prompt Templates

### Planning Agent
```
Break the following task into numbered implementation steps for a software project.
Be specific about files to create or modify.
Task: <task>
```

### Review Agent
```
Review the following code diff for bugs and style issues.
Respond only with: PASS or FAIL and reasons.
Diff: <diff>
```

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
