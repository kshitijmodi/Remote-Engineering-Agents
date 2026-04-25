const { readFileForTransfer } = require('../utils/FileHandler');
const {
  extractFileHint,
  findInRecentFiles,
  findInDirectories,
} = require('../utils/FileMatching');

/**
 * FileAgent
 *
 * Handles FILE_SEND intents — extracts the requested file path from the user's
 * message, reads the file via FileHandler (which enforces size limits and path
 * validation), and delivers it as a WhatsApp media attachment via the messaging
 * layer.
 *
 * When no explicit path is present the agent performs fuzzy matching against
 * recently-accessed files (from conversation context) and/or a list of search
 * directories.  If multiple candidates are found the user is asked to clarify.
 */
class FileAgent {
  /**
   * @param {import('../messaging/MessagingLayer').MessagingLayer} messagingLayer
   */
  constructor(messagingLayer) {
    this._messaging = messagingLayer;
  }

  /**
   * Handle a FILE_SEND request from a user.
   *
   * Parses the file path out of the message, reads and base64-encodes the file,
   * then sends it as a document/media attachment.  Any error (path invalid, file
   * too large, blocked extension, etc.) is caught and reported back to the user
   * as a plain-text reply.
   *
   * @param {string} userId   - WhatsApp user ID
   * @param {string} message  - Raw message text, e.g. "send me the report"
   * @param {object} [context]
   * @param {string[]} [context.recentFiles]  - recently accessed/mentioned file paths
   * @param {string[]} [context.searchDirs]   - directories to scan for fuzzy matches
   * @returns {Promise<void>}
   */
  async handle(userId, message, context = {}) {
    let filePath;

    // ── 1. Try to extract an explicit path from the message ──────────────────
    try {
      filePath = this._extractPath(message);
    } catch (_) {
      // No explicit path — fall through to fuzzy resolution
    }

    // ── 2. Fuzzy resolution when no explicit path was found ──────────────────
    if (!filePath) {
      const resolved = await this._resolveVagueReference(userId, message, context);
      if (!resolved) return; // error or clarification already sent
      filePath = resolved;
    }

    console.log(`[FileAgent] User ${userId} requested file: ${filePath}`);

    let fileData;
    try {
      fileData = this.prepareFileTransfer(filePath);
    } catch (err) {
      console.error(`[FileAgent] Failed to read file "${filePath}":`, err.message);
      await this._messaging.sendMessage(userId, `Failed to send file: ${err.message}`);
      return;
    }

    const { base64, filename, mimeType, size } = fileData;
    const sizeKB = (size / 1024).toFixed(1);

    const mediaItem = {
      mimeType,
      data: base64,
      filename,
      caption: `${filename} (${sizeKB} KB)`,
    };

    try {
      if (typeof this._messaging.sendDocument === 'function') {
        await this._messaging.sendDocument(userId, mediaItem);
      } else if (typeof this._messaging.sendMediaMessage === 'function') {
        await this._messaging.sendMediaMessage(userId, mediaItem);
      } else {
        // Last-resort fallback: notify the user we cannot deliver the raw file
        await this._messaging.sendMessage(
          userId,
          `File ready: *${filename}* (${sizeKB} KB)\nMedia sending is not supported by the current provider.`
        );
      }
      console.log(`[FileAgent] Sent file "${filename}" (${sizeKB} KB) to ${userId}`);
    } catch (err) {
      console.error(`[FileAgent] Failed to send file "${filename}" to ${userId}:`, err.message);
      await this._messaging.sendMessage(userId, `Error delivering file: ${err.message}`);
    }
  }

  // ─── Public helpers ────────────────────────────────────────────────────────

  /**
   * Read a file and return its metadata, suitable for passing to
   * WhatsAppProvider.sendFileAttachment() or inspecting before delivery.
   *
   * Delegates all security validation (path traversal, blocked extensions,
   * size limits, existence) to FileHandler.readFileForTransfer().
   *
   * @param {string} filePath - path supplied by the caller (may be relative)
   * @returns {{
   *   base64: string,
   *   resolvedPath: string,
   *   filename: string,
   *   mimeType: string,
   *   size: number,
   *   mtime: Date
   * }}
   * @throws {Error} if the file fails any security check or cannot be read
   */
  prepareFileTransfer(filePath) {
    return readFileForTransfer(filePath);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Extract an explicit file path from a natural-language message.
   *
   * Supports:
   *   - Quoted paths:                       'send "logs/app.log"'
   *   - Absolute Unix/Windows paths:        "send me /var/log/app.log"
   *   - A word that looks like a filename:  "send report.pdf"
   *
   * Throws if no explicit path token is found (caller should fall back to
   * fuzzy resolution via _resolveVagueReference).
   *
   * @param {string} message
   * @returns {string}
   * @throws {Error} when no explicit path is identifiable
   */
  _extractPath(message) {
    if (!message || typeof message !== 'string') {
      throw new Error('Empty message');
    }

    // 1. Quoted path — single or double quotes
    const quotedMatch = message.match(/["']([^"']+)["']/);
    if (quotedMatch) return quotedMatch[1].trim();

    // 2. Absolute Unix/Windows path or explicit relative path with a separator
    const absMatch = message.match(/([/\\][^\s]+|[A-Za-z]:[/\\][^\s]+)/);
    if (absMatch) return absMatch[1].trim();

    // 3. A word that looks like a file (has an extension)
    const extMatch = message.match(/\b(\S+\.\w{1,6})\b/);
    if (extMatch) return extMatch[1].trim();

    throw new Error('No file path found in message');
  }

  /**
   * Attempt to resolve a vague file reference (e.g. "that document", "the pdf",
   * "my report") using FileMatching utilities.
   *
   * Resolution order:
   *   1. Recent files from conversation context (fastest, most relevant)
   *   2. Scan searchDirs with fuzzy matching (broader fallback)
   *
   * Returns the resolved absolute path, or `null` after sending an appropriate
   * message to the user (clarification request or "no match" notice).
   *
   * @param {string}   userId
   * @param {string}   message
   * @param {object}   context
   * @param {string[]} [context.recentFiles]
   * @param {string[]} [context.searchDirs]
   * @returns {Promise<string|null>}
   */
  async _resolveVagueReference(userId, message, context) {
    const hint = extractFileHint(message);

    if (!hint) {
      await this._messaging.sendMessage(
        userId,
        "I couldn't figure out which file you meant. Please specify a filename or path."
      );
      return null;
    }

    console.log(`[FileAgent] Fuzzy resolving hint "${hint}" for user ${userId}`);

    let matches = [];

    // ── Priority 1: recent files from conversation context ───────────────────
    const recentFiles = context.recentFiles || [];
    if (recentFiles.length > 0) {
      matches = findInRecentFiles(hint, recentFiles, { limit: 5 });
    }

    // ── Priority 2: scan provided search directories ─────────────────────────
    if (matches.length === 0) {
      const searchDirs = context.searchDirs || [];
      if (searchDirs.length > 0) {
        matches = findInDirectories(hint, searchDirs, { limit: 5 });
      }
    }

    if (matches.length === 0) {
      await this._messaging.sendMessage(
        userId,
        `I couldn't find any file matching *"${hint}"*. Please check the name and try again.`
      );
      return null;
    }

    // ── Exact / unambiguous match ────────────────────────────────────────────
    if (matches.length === 1 || matches[0].score >= 1.0) {
      console.log(`[FileAgent] Resolved "${hint}" → "${matches[0].filePath}" (score ${matches[0].score})`);
      return matches[0].filePath;
    }

    // ── High-confidence single best match (score ≥ 0.9, clearly ahead) ───────
    if (matches[0].score >= 0.9 && (matches.length < 2 || matches[0].score - matches[1].score >= 0.2)) {
      console.log(`[FileAgent] High-confidence match "${hint}" → "${matches[0].filePath}" (score ${matches[0].score})`);
      return matches[0].filePath;
    }

    // ── Ambiguous: ask for clarification ─────────────────────────────────────
    const options = matches
      .slice(0, 5)
      .map((m, i) => `  ${i + 1}. ${m.filename}`)
      .join('\n');

    await this._messaging.sendMessage(
      userId,
      `I found multiple files matching *"${hint}"*. Which one did you mean?\n${options}\n\nReply with the number or the exact filename.`
    );
    return null;
  }
}

module.exports = { FileAgent };
