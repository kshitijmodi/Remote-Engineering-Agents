const { readFileForTransfer } = require('../utils/FileHandler');

/**
 * FileAgent
 *
 * Handles FILE_SEND intents — extracts the requested file path from the user's
 * message, reads the file via FileHandler (which enforces size limits and path
 * validation), and delivers it as a WhatsApp media attachment via the messaging
 * layer.
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
   * @param {string} userId  - WhatsApp user ID
   * @param {string} message - Raw message text, e.g. "send me file /var/log/app.log"
   * @returns {Promise<void>}
   */
  async handle(userId, message) {
    let filePath;
    try {
      filePath = this._extractPath(message);
    } catch (err) {
      await this._messaging.sendMessage(userId, `Could not determine file path: ${err.message}`);
      return;
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
   * Extract the file path from a natural-language message.
   *
   * Supports:
   *   - Explicit absolute/relative paths:  "send me /var/log/app.log"
   *   - Quoted paths:                       'send "logs/app.log"'
   *   - Last token fallback when no path is found
   *
   * @param {string} message
   * @returns {string}
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
}

module.exports = { FileAgent };
