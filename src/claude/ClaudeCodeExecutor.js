const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { buildContentBlocksFromAttachments } = require('../utils/MultimodalHandler');

const IS_WINDOWS = process.platform === 'win32';

/**
 * Build an array of Claude API content blocks from a `media` descriptor object.
 * Combines attachment blocks (images, PDFs) with text summaries of fetched links.
 *
 * @param {{ attachments?: Array, links?: Array }|undefined} media
 * @returns {Array<object>} Claude API content blocks (empty array when no media)
 */
function buildMultimodalBlocks(media) {
  if (!media) return [];

  const blocks = [];

  // Image / PDF attachments → typed content blocks
  if (Array.isArray(media.attachments) && media.attachments.length > 0) {
    const attachmentBlocks = buildContentBlocksFromAttachments(media.attachments);
    blocks.push(...attachmentBlocks);
  }

  // Processed link results → text blocks with fetched content
  if (Array.isArray(media.links) && media.links.length > 0) {
    for (const link of media.links) {
      if (!link.valid || link.error) continue;
      if (link.category === 'text' && link.textContent) {
        const snippet = link.textContent.slice(0, 8000); // cap per-link context
        blocks.push({
          type: 'text',
          text: `[Link: ${link.url}]\n${snippet}`,
        });
      } else {
        // Non-text links: include at least the URL and content type as context
        blocks.push({
          type: 'text',
          text: `[Link: ${link.url}] (content-type: ${link.contentType ?? 'unknown'}, category: ${link.category})`,
        });
      }
    }
  }

  return blocks;
}

/**
 * Wraps Claude Code CLI invocations.
 * All agents use this — never call LLM APIs directly.
 *
 * Usage:
 *   const executor = new ClaudeCodeExecutor({ maxInvocations: 15 });
 *   const result = await executor.run('Add CSV export to utils/export.js', '/workspace/my-repo');
 */
class ClaudeCodeExecutor {
  constructor({ maxInvocations = 60, timeoutMs = 3_600_000 } = {}) {
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
   * @param {object}   opts.media          - Multimodal content to include
   * @param {Array}    opts.media.attachments - Raw attachment objects (images/PDFs from WhatsApp)
   * @param {Array}    opts.media.links       - Processed link results from LinkProcessor
   * @returns {Promise<ExecutionResult>}
   */
  async run(prompt, repoPath, { allowedTools, disallowedTools, onProgress, model, media } = {}) {
    if (this.budgetExceeded) {
      throw new BudgetExceededError(this.budgetStatus);
    }

    if (!repoPath) {
      throw new Error('repoPath is required');
    }

    this.invocations += 1;
    const invocationIndex = this.invocations;

    // Save attachments to temp files so Claude can read them via its Read tool.
    // Track paths for cleanup after the run.
    const tempFiles = [];
    const attachmentContext = [];

    if (Array.isArray(media?.attachments) && media.attachments.length > 0) {
      for (const attachment of media.attachments) {
        if (!attachment.data) continue;
        const ext = attachment.mimeType === 'application/pdf' ? '.pdf'
          : attachment.mimeType === 'image/png'  ? '.png'
          : attachment.mimeType === 'image/jpeg' ? '.jpg'
          : attachment.mimeType === 'image/webp' ? '.webp'
          : attachment.mimeType === 'image/gif'  ? '.gif'
          : '.bin';
        const tmpPath = path.join(os.tmpdir(), `rea_attachment_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
        try {
          fs.writeFileSync(tmpPath, Buffer.from(attachment.data, 'base64'));
          tempFiles.push(tmpPath);
          if (attachment.type === 'pdf') {
            attachmentContext.push(`The user attached a PDF document. It has been saved to: ${tmpPath}\nUse the Read tool to read its contents.`);
          } else {
            attachmentContext.push(`The user attached an image (${attachment.mimeType}). It has been saved to: ${tmpPath}\nNote: The Read tool can inspect the file but cannot visually interpret image pixels.`);
          }
        } catch (err) {
          console.warn('[ClaudeCodeExecutor] Failed to save attachment to temp file:', err.message);
        }
      }
    }

    // Build link context (fetched webpage text)
    const mediaBlocks = buildMultimodalBlocks(media);

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'text',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--verbose',
    ];

    if (model) {
      args.push('--model', model);
    }
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
        windowsHide: true,
      });

      // Append .env block instruction to every prompt
      const safePrompt = prompt + ClaudeCodeExecutor.ENV_BLOCK_PROMPT;

      // Write prompt/content to stdin, then close.
      // Multimodal: send a JSON messages array with mixed content blocks.
      // Text-only: send the prompt as plain text (default mode).
      // Suppress EPIPE/EOF errors on stdin — these are non-fatal if the process
      // exits before we finish writing (e.g. immediate error from the CLI).
      proc.stdin.on('error', (err) => {
        console.warn('[ClaudeCodeExecutor] stdin write error:', err.code ?? err.message);
      });

      // Build full prompt: user prompt + attachment file paths + fetched link text
      const linkContext = mediaBlocks
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n\n');

      const stdinPayload = [
        safePrompt,
        ...attachmentContext,
        linkContext || '',
      ].filter(Boolean).join('\n\n');

      // Use end() to write+close in one shot — avoids partial-write EOF errors on large payloads
      proc.stdin.end(stdinPayload, 'utf8');

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

        // Clean up temp attachment files
        for (const tmpPath of tempFiles) {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        }

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

module.exports = { ClaudeCodeExecutor, BudgetExceededError, ExecutionTimeoutError, ExecutionError, buildMultimodalBlocks };
