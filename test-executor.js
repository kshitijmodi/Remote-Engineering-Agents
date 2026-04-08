/**
 * Smoke test for ClaudeCodeExecutor.
 * Run: node test-executor.js
 *
 * Uses the current working directory as the repo — safe read-only prompt.
 */

const path = require('path');
const { ClaudeCodeExecutor, BudgetExceededError } = require('./src/claude/ClaudeCodeExecutor');

const REPO_PATH = path.resolve(__dirname);

async function main() {
  const executor = new ClaudeCodeExecutor({ maxInvocations: 3, timeoutMs: 120_000 });

  console.log('=== Test 1: Basic execution ===');
  try {
    const result = await executor.run(
      'List the files in the current directory and tell me what this project does in 2 sentences.',
      REPO_PATH,
      {
        allowedTools: ['Bash', 'Read', 'Glob'],
        onProgress: (event) => {
          if (event.type === 'assistant') process.stdout.write('.');
        },
      }
    );

    console.log('\nSuccess:', result.success);
    console.log('Exit code:', result.exitCode);
    console.log('Budget after:', `${result.budget.current}/${result.budget.max}`);
    console.log('Output:\n', result.output);
  } catch (err) {
    console.error('FAILED:', err.message);
  }

  console.log('\n=== Test 2: Budget enforcement ===');
  // Exhaust the budget
  const tinyExecutor = new ClaudeCodeExecutor({ maxInvocations: 1 });
  await tinyExecutor.run('Say hello in one word.', REPO_PATH, { allowedTools: [] });

  try {
    await tinyExecutor.run('Say hello again.', REPO_PATH, { allowedTools: [] });
    console.error('FAILED: Should have thrown BudgetExceededError');
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.log('Budget enforcement works:', err.message);
    } else {
      console.error('Wrong error type:', err.message);
    }
  }

  console.log('\n=== Test 3: Budget extension ===');
  tinyExecutor.extendBudget(5);
  console.log('Budget after extend:', tinyExecutor.budgetStatus);

  console.log('\nAll tests done.');
}

main().catch(console.error);
