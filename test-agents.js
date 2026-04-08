const { PlanningAgent }     = require('./src/agents/PlanningAgent');
const { ExecutionAgent }    = require('./src/agents/ExecutionAgent');
const { DebuggingAgent }    = require('./src/agents/DebuggingAgent');
const { ReviewAgent }       = require('./src/agents/ReviewAgent');
const { LoggingAgent }      = require('./src/agents/LoggingAgent');
const { OrchestratorAgent, STATES } = require('./src/agents/OrchestratorAgent');
const { BudgetExceededError } = require('./src/claude/ClaudeCodeExecutor');

const mockBudget = { current: 2, max: 15 };
const fakeExec = {
  budgetStatus: mockBudget,
  extendBudget: () => {},
  run: async () => ({ success: true, output: '', budget: mockBudget, exitCode: 0 }),
};

async function main() {
  console.log('All modules load OK\n');

  // ── PlanningAgent ────────────────────────────────────────────────────────
  const planner = new PlanningAgent(fakeExec);
  const steps = planner._parseSteps('1. Create utils/export.js\n2. Add exportToCsv function\n3. Write tests');
  console.assert(steps.length === 3, 'PlanningAgent: 3 steps');
  console.assert(steps[0] === 'Create utils/export.js', 'PlanningAgent: step text');
  console.log('PASS: PlanningAgent step parsing');

  // ── ReviewAgent ──────────────────────────────────────────────────────────
  const reviewer = new ReviewAgent(fakeExec);
  console.assert(reviewer._parseVerdict('PASS - looks good').verdict === 'PASS', 'ReviewAgent: PASS');
  console.assert(reviewer._parseVerdict('FAIL: Missing null check').verdict === 'FAIL', 'ReviewAgent: FAIL');
  console.assert(reviewer._parseVerdict('PASS but also FAIL').verdict === 'FAIL', 'ReviewAgent: FAIL takes priority');
  console.log('PASS: ReviewAgent verdict parsing');

  // ── LoggingAgent ─────────────────────────────────────────────────────────
  const logger = new LoggingAgent();
  logger.startTask('test-001');
  logger.log('test-001', 'INFO', 'Hello from test');
  logger.log('test-001', 'STATE', 'queued → planning');
  logger.checkpoint('test-001', { status: 'planning', retries: {} });
  const cp = logger.loadCheckpoint('test-001');
  console.assert(cp?.status === 'planning', 'LoggingAgent: checkpoint round-trips');
  logger.endTask('test-001');
  const tail = logger.getTailLogs('test-001', 10);
  console.assert(tail.includes('INFO'), 'LoggingAgent: tail contains entries');
  console.log('PASS: LoggingAgent write/checkpoint/read');

  // ── OrchestratorAgent: happy path ────────────────────────────────────────
  const messages = [];
  const agents = {
    executor:  fakeExec,
    planning:  new PlanningAgent(fakeExec),
    execution: new ExecutionAgent(fakeExec),
    debugging: new DebuggingAgent(fakeExec),
    review:    new ReviewAgent(fakeExec),
    logging:   new LoggingAgent(),
  };
  agents.planning.plan      = async () => ({ success: true, steps: ['Step 1', 'Step 2'], rawOutput: '', budget: mockBudget });
  agents.execution.code     = async () => ({ success: true, output: 'Done', budget: mockBudget, exitCode: 0 });
  agents.execution.test     = async () => ({ passed: true, passedCount: 4, failedCount: 0, details: 'All passed', rawOutput: '', budget: mockBudget, executorSuccess: true });
  agents.review.review      = async () => ({ passed: true, verdict: 'PASS', reasons: 'Looks good', diff: '', budget: mockBudget });

  const orch = new OrchestratorAgent(agents, async (uid, msg) => messages.push(msg));
  orch.startTask('user@c.us', 'Add CSV export', '/fake/path');
  await new Promise(r => setTimeout(r, 500));

  console.assert(messages.some(m => m.includes('Planning')),    'Orchestrator: planning msg');
  console.assert(messages.some(m => m.includes('Coding')),      'Orchestrator: coding msg');
  console.assert(messages.some(m => m.includes('Tests passed')),'Orchestrator: tests passed');
  console.assert(messages.some(m => m.includes('PASS')),        'Orchestrator: review pass');
  console.log('PASS: OrchestratorAgent happy path');

  // ── OrchestratorAgent: debug retry loop ─────────────────────────────────
  let debugCalls = 0;
  const failMessages = [];
  const agents2 = { ...agents, logging: new LoggingAgent() };
  agents2.execution = new ExecutionAgent(fakeExec);
  agents2.execution.code = async () => ({ success: true, output: 'Done', budget: mockBudget, exitCode: 0 });
  // Fail tests twice, pass on 3rd
  let testAttempts = 0;
  agents2.execution.test = async () => {
    testAttempts++;
    if (testAttempts <= 2) return { passed: false, passedCount: 0, failedCount: 1, details: 'TypeError', rawOutput: 'fail', budget: mockBudget, executorSuccess: true };
    return { passed: true, passedCount: 3, failedCount: 0, details: '', rawOutput: '', budget: mockBudget, executorSuccess: true };
  };
  agents2.debugging = new DebuggingAgent(fakeExec);
  agents2.debugging.fix = async (...args) => { debugCalls++; return { success: true, output: 'Fixed', attempt: args[3], budget: mockBudget, exitCode: 0 }; };
  agents2.review = new ReviewAgent(fakeExec);
  agents2.review.review = async () => ({ passed: true, verdict: 'PASS', reasons: '', diff: '', budget: mockBudget });

  const orch2 = new OrchestratorAgent(agents2, async (uid, msg) => failMessages.push(msg));
  orch2.startTask('user2@c.us', 'Add feature', '/fake/path');
  await new Promise(r => setTimeout(r, 600));

  console.assert(debugCalls === 2, `Orchestrator: debugger called ${debugCalls} times (expected 2)`);
  console.assert(failMessages.some(m => m.includes('debug attempt')), 'Orchestrator: debug attempt msg sent');
  console.assert(failMessages.some(m => m.includes('PASS')), 'Orchestrator: eventually passed');
  console.log('PASS: OrchestratorAgent debug retry loop');

  // ── OrchestratorAgent: budget exceeded → PAUSED ──────────────────────────
  const budgetExec = {
    budgetStatus: { current: 15, max: 15 },
    extendBudget: () => {},
    run: async () => { throw new BudgetExceededError({ current: 15, max: 15 }); },
  };
  const pausedMsgs = [];
  const agents3 = { ...agents, executor: budgetExec, logging: new LoggingAgent() };
  agents3.planning = new PlanningAgent(budgetExec);
  agents3.planning.plan = async () => { throw new BudgetExceededError({ current: 15, max: 15 }); };
  const orch3 = new OrchestratorAgent(agents3, async (uid, msg) => pausedMsgs.push(msg));
  orch3.startTask('user3@c.us', 'Some task', '/fake/path');
  await new Promise(r => setTimeout(r, 300));
  const t3 = orch3.getActiveTask('user3@c.us');
  console.assert(t3?.status === STATES.PAUSED, `Orchestrator: status is ${t3?.status}, expected paused`);
  console.assert(pausedMsgs.some(m => m.includes('execution limit')), 'Orchestrator: budget msg sent');
  console.log('PASS: OrchestratorAgent budget exhaustion → PAUSED');

  // ── OrchestratorAgent: cancel ────────────────────────────────────────────
  const agents4 = { ...agents, logging: new LoggingAgent() };
  agents4.planning = new PlanningAgent(fakeExec);
  // Planning hangs — simulates long-running task
  agents4.planning.plan = () => new Promise(() => {});
  const orch4 = new OrchestratorAgent(agents4, async () => {});
  orch4.startTask('user4@c.us', 'Long task', '/fake/path');
  await new Promise(r => setTimeout(r, 50));
  orch4.cancelTask('user4@c.us');
  await new Promise(r => setTimeout(r, 100));
  const t4 = orch4.getActiveTask('user4@c.us');
  console.assert(t4?.status === STATES.CANCELLED, 'Orchestrator: cancel sets CANCELLED');
  console.log('PASS: OrchestratorAgent cancel');

  console.log('\nAll agent tests passed.');
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
