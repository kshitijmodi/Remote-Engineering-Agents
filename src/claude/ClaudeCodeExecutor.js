const { spawn } = require('child_process');
const path = require('path');

const IS_WINDOWS = process.platform === 'win32';

/**
 * Wraps Claude Code CLI invocations.
 * All agents use this — never call LLM APIs directly.
 *
 * Usage:
 *   const executor = new ClaudeCodeExecutor({ maxInvocations: 15 });
 *   const result = await executor.run('Add CSV export to utils/export.js', '/workspace/my-repo');
 */
class ClaudeCodeExecutor {
  constructor({ maxInvocations = 15, timeoutMs = 300_000 } = {}) {
    this.maxInvocations = maxInvocations;
    this.timeoutMs = timeoutMs;
    this.invocations = 0;
  }

  // .env files are always blocked — injected into every run's disallowedTools
  static ENV_BLOCK_PROMPT = '\n\nIMPORTANT: Do NOT read, edit, or create any .env files.';

  get budgetExceeded() {
    return this.invocations >= this.maxInvocations;
  }

  get budgetStatus() {
    return { current: this.invocations, max: this.maxInvocations };
  }

  extendBudget(extra = 10) {
    this.maxInvocations += extra;
  }

  resetBudget() {
    this.invocations = 0;
  }

  /**
   * Run a prompt against Claude Code CLI in the given repo directory.
   *
   * @param {string} prompt  - The task/instruction for Claude Code
   * @param {string} repoPath - Absolute path to the repo workspace
   * @param {object} opts
   * @param {string[]} opts.allowedTools   - Tool whitelist (default: all)
   * @param {string[]} opts.disallowedTools - Tool blacklist
   * @param {function} opts.onProgress     - Called with each streaming event
   * @returns {Promise<ExecutionResult>}
   */
  async run(prompt, repoPath, { allowedTools, disallowedTools, onProgress } = {}) {
    if (this.budgetExceeded) {
      throw new BudgetExceededError(this.budgetStatus);
    }

    if (!repoPath) {
      throw new Error('repoPath is required');
    }

    this.invocations += 1;
    const invocationIndex = this.invocations;

    // Prompt is passed via stdin to avoid shell argument escaping issues on Windows.
    // --input-format text is the default; --verbose is required with stream-json.
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'text',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--verbose',
    ];

    if (allowedTools?.length) {
      args.push('--allowedTools', allowedTools.join(','));
    }
    if (disallowedTools?.length) {
      args.push('--disallowedTools', disallowedTools.join(','));
    }

    return new Promise((resolve, reject) => {
      // Strip CLAUDECODE so nested sessions are allowed.
      // In production this won't be set; only needed when testing inside Claude Code itself.
      const { CLAUDECODE: _stripped, ...cleanEnv } = process.env;

      // On Windows, npm globals are .cmd wrappers. Using `cmd /c claude` with shell:false
      // avoids shell:true argument mangling while still resolving the .cmd correctly.
      const [bin, binArgs] = IS_WINDOWS
        ? ['cmd', ['/c', 'claude', ...args]]
        : ['claude', args];

      const proc = spawn(bin, binArgs, {
        cwd: repoPath,
        env: cleanEnv,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Append .env block instruction to every prompt
      const safePrompt = prompt + ClaudeCodeExecutor.ENV_BLOCK_PROMPT;

      // Write prompt to stdin, then close — this is how --print mode accepts input.
      proc.stdin.write(safePrompt);
      proc.stdin.end();

      const events = [];
      let outputText = '';
      let errorText = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        reject(new ExecutionTimeoutError(this.timeoutMs, invocationIndex));
      }, this.timeoutMs);

      // stdout arrives as newline-delimited JSON
      let buffer = '';
      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            events.push(event);

            // Extract readable text from assistant messages
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'text') outputText += block.text;
              }
            }

            onProgress?.(event);
          } catch {
            // Non-JSON line (rare) — treat as plain text
            outputText += line + '\n';
          }
        }
      });

      proc.stderr.on('data', (chunk) => {
        errorText += chunk.toString();
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new ExecutionError(`Failed to spawn claude: ${err.message}`, invocationIndex));
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return; // already rejected

        // Find the final result event
        const resultEvent = events.findLast?.(e => e.type === 'result')
          ?? events.slice().reverse().find(e => e.type === 'result');

        const isError = resultEvent?.is_error === true || (code !== 0 && !resultEvent);

        resolve({
          success: !isError,
          exitCode: code,
          output: outputText.trim(),
          errorOutput: errorText.trim(),
          resultEvent,
          events,
          invocationIndex,
          budget: { ...this.budgetStatus },
        });
      });
    });
  }
}

class BudgetExceededError extends Error {
  constructor(budget) {
    super(`Invocation budget exhausted (${budget.current}/${budget.max})`);
    this.name = 'BudgetExceededError';
    this.budget = budget;
  }
}

class ExecutionTimeoutError extends Error {
  constructor(timeoutMs, invocationIndex) {
    super(`Claude Code timed out after ${timeoutMs / 1000}s (invocation #${invocationIndex})`);
    this.name = 'ExecutionTimeoutError';
    this.invocationIndex = invocationIndex;
  }
}

class ExecutionError extends Error {
  constructor(message, invocationIndex) {
    super(message);
    this.name = 'ExecutionError';
    this.invocationIndex = invocationIndex;
  }
}

module.exports = { ClaudeCodeExecutor, BudgetExceededError, ExecutionTimeoutError, ExecutionError };
