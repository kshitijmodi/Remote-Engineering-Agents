const { Client, LocalAuth, Buttons, List, MessageMedia } = require('whatsapp-web.js');
const { buildQuickReply, buildListMessage } = require('../ui/WhatsAppButtons');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { MessagingLayer, buildMessage } = require('./MessagingLayer');
const { extractMediaMetadata } = require('../utils/MultimodalHandler');

// Message types that may carry media or text we want to process
const SUPPORTED_MSG_TYPES = new Set(['chat', 'image', 'document']);

// Simple URL extractor — captures http/https links from free text
const URL_REGEX = /https?:\/\/[^\s<>"']+/g;

const AUTH_PATH = path.resolve('./.wwebjs_auth_business');

/**
 * WhatsApp implementation of MessagingLayer via whatsapp-web.js.
 *
 * On first run, prints a QR code to the terminal — scan it with WhatsApp
 * to authenticate. Session is persisted locally so subsequent restarts
 * don't need a new QR scan.
 */
class WhatsAppProvider extends MessagingLayer {
  constructor() {
    super();
    // Kill any leftover Chromium from a previous crashed run before starting
    try { execSync('pkill -9 -f puppeteer/chrome 2>/dev/null || true', { stdio: 'ignore' }); } catch {}
    const sessionDir = path.join(AUTH_PATH, 'session');
    if (fs.existsSync(sessionDir)) {
      ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach(f => {
        try { fs.unlinkSync(path.join(sessionDir, f)); } catch {}
      });
    }
    this._client = new Client({
      authStrategy: new LocalAuth({ dataPath: AUTH_PATH }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1280,800',
        ],
      },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });
    this._messageCallback = null;
    this._connected = false;
    this._qrShown = false;
    this._setupListeners();
  }

  _setupListeners() {
    this._client.on('qr', (qr) => {
      if (!this._qrShown) {
        console.log('\nScan this QR code with WhatsApp to authenticate:\n');
        qrcode.generate(qr, { small: true });
        this._qrShown = true;
      }
    });

    this._client.on('ready', async () => {
      this._connected = true;
      // Remove webdriver flag so WhatsApp can't detect headless automation
      try {
        const page = await this._client.pupPage;
        if (page) {
          await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          });
        }
      } catch {}
      console.log('[WhatsApp] Connected and ready.');
    });

    this._client.on('disconnected', (reason) => {
      this._connected = false;
      console.warn('[WhatsApp] Disconnected:', reason);
    });

    // Business number setup: incoming messages from other people.
    // fromMe=false means someone else sent this — no self-loop risk.
    // Using async so we can await media downloads before invoking the callback.
    this._client.on('message', async (msg) => {
      if (msg.from === 'status@broadcast') return; // ignore WhatsApp status updates
      if (!this._messageCallback && !this._buttonResponseHandler) return;
      if (!SUPPORTED_MSG_TYPES.has(msg.type)) return;
      if (msg.fromMe) return;

      // Use the @c.us ID for sending replies if available, fall back to msg.from
      const userId = msg.author || msg.from;

      // Extract any URLs present in the message text and wrap as LinkObjects
      const links = msg.body
        ? (msg.body.match(URL_REGEX) || []).map((url) => ({ url, title: null, description: null }))
        : [];

      // Download media attachment when the message carries one (image, PDF, etc.)
      // Each entry is enriched with normalised metadata via MultimodalHandler so
      // downstream agents receive a consistent {type, mimeType, filename, filesize, data} shape.
      let media = [];
      if (msg.hasMedia) {
        try {
          const attachment = await msg.downloadMedia();
          if (attachment) {
            const metadata = extractMediaMetadata(attachment);
            media = [metadata];
          }
        } catch (err) {
          console.warn('[WhatsApp] Failed to download media:', err.message);
        }
      }

      const normalized = buildMessage({
        userId,
        text: msg.body ? msg.body.trim() : '',
        receivedAt: new Date(msg.timestamp * 1000),
        media,
        links,
      });

      this._dispatchMessage(normalized);
    });
  }

  async connect() {
    console.log('[WhatsApp] Initializing...');
    await this._client.initialize();
  }

  async disconnect() {
    await this._client.destroy();
    this._connected = false;
    console.log('[WhatsApp] Disconnected.');
  }

  onMessage(callback) {
    this._messageCallback = callback;
  }

  /**
   * @param {string} userId - WhatsApp chat ID (e.g. "447911123456@c.us")
   * @param {string} text
   */
  async sendMessage(userId, text) {
    if (!this._connected) {
      throw new Error('[WhatsApp] Cannot send — not connected');
    }
    await this._client.sendMessage(userId, text);
  }

  /**
   * Send a quick-reply button message (up to 3 tappable buttons).
   *
   * @param {string} userId - WhatsApp chat ID (e.g. "447911123456@c.us")
   * @param {{ type: 'quick_reply', payload: object }} quickReply
   *   Payload produced by buildQuickReply() from src/ui/WhatsAppButtons.js
   */
  async sendQuickReply(userId, quickReply) {
    if (!this._connected) {
      throw new Error('[WhatsApp] Cannot send — not connected');
    }
    const { payload } = quickReply;
    const buttons = payload.action.buttons.map((btn) => ({
      id:   btn.reply.id,
      body: btn.reply.title,
    }));
    const title  = payload.header ? payload.header.text : '';
    const footer = payload.footer ? payload.footer.text : '';
    const msg = new Buttons(payload.body.text, buttons, title, footer);
    await this._client.sendMessage(userId, msg);
  }

  /**
   * Send a list message (sectioned menu with a list-picker button).
   *
   * @param {string} userId - WhatsApp chat ID (e.g. "447911123456@c.us")
   * @param {{ type: 'list', payload: object }} listMessage
   *   Payload produced by buildListMessage() from src/ui/WhatsAppButtons.js
   */
  async sendListMessage(userId, listMessage) {
    if (!this._connected) {
      throw new Error('[WhatsApp] Cannot send — not connected');
    }
    const { payload } = listMessage;
    const title  = payload.header ? payload.header.text : '';
    const footer = payload.footer ? payload.footer.text : '';
    const msg = new List(
      payload.body.text,
      payload.action.button,
      payload.action.sections,
      title,
      footer,
    );
    await this._client.sendMessage(userId, msg);
  }

  /**
   * Send a file as a document attachment.
   *
   * Implements the MessagingLayer base-class interface:
   *   sendDocument(userId, attachment)
   * where attachment = { mimeType, data, filename, caption }
   *
   * @param {string} userId      - WhatsApp chat ID (e.g. "447911123456@c.us")
   * @param {object} attachment  - File attachment payload
   * @param {string} attachment.mimeType - MIME type (e.g. "application/pdf")
   * @param {string} attachment.data     - Base-64 encoded file contents
   * @param {string} attachment.filename - File name shown to the recipient
   * @param {string} [attachment.caption] - Optional caption
   */
  async sendDocument(userId, attachment) {
    if (!this._connected) {
      throw new Error('[WhatsApp] Cannot send — not connected');
    }
    const { mimeType, data, filename, caption = '' } = attachment;
    const media = new MessageMedia(mimeType, data, filename);
    await this._client.sendMessage(userId, media, { caption, sendMediaAsDocument: true });
  }

  /**
   * Send a file attachment via WhatsApp, auto-detecting MIME type from the extension.
   *
   * @param {string} to       - WhatsApp chat ID (e.g. "447911123456@c.us")
   * @param {string} filePath - Absolute path to the file on disk
   */
  async sendFileAttachment(to, filePath) {
    if (!this._connected) {
      throw new Error('[WhatsApp] Cannot send — not connected');
    }
    // Validate file existence, type, and size before reading
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      if (err.code === 'EACCES') {
        throw new Error(`[WhatsApp] Access denied: ${filePath}`);
      }
      throw new Error(`[WhatsApp] File not found: ${filePath}`);
    }

    if (!stat.isFile()) {
      throw new Error(`[WhatsApp] Path is not a file: ${filePath}`);
    }

    // WhatsApp document uploads are capped at 64 MB
    const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      const sizeMB  = (stat.size / (1024 * 1024)).toFixed(2);
      const limitMB = (MAX_ATTACHMENT_BYTES / (1024 * 1024)).toFixed(0);
      throw new Error(`[WhatsApp] File too large: ${sizeMB} MB exceeds the ${limitMB} MB limit`);
    }

    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();
    const MIME_MAP = {
      '.pdf':  'application/pdf',
      '.doc':  'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls':  'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.txt':  'text/plain',
      '.csv':  'text/csv',
      '.png':  'image/png',
      '.jpg':  'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif':  'image/gif',
      '.zip':  'application/zip',
      '.json': 'application/json',
    };
    const mimeType = MIME_MAP[ext] || 'application/octet-stream';
    let fileData;
    try {
      fileData = fs.readFileSync(filePath);
    } catch (err) {
      if (err.code === 'EACCES') {
        throw new Error(`[WhatsApp] Access denied: cannot read file ${filePath}`);
      }
      throw err;
    }
    const base64Data = fileData.toString('base64');
    const media = new MessageMedia(mimeType, base64Data, filename);
    await this._client.sendMessage(to, media, { sendMediaAsDocument: true });
  }

  getStatus() {
    return {
      connected: this._connected,
      provider: 'whatsapp',
    };
  }
}

module.exports = { WhatsAppProvider };
