const { Client, LocalAuth, Buttons, List, MessageMedia } = require('whatsapp-web.js');
const { buildQuickReply, buildListMessage } = require('../ui/WhatsAppButtons');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { MessagingLayer, buildMessage } = require('./MessagingLayer');
const { extractMediaMetadata } = require('../utils/MultimodalHandler');

// Message types that may carry media or text we want to process
const SUPPORTED_MSG_TYPES = new Set(['chat', 'image', 'document', 'buttons_response', 'list_response']);

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
    this._client = new Client({
      authStrategy: new LocalAuth({ dataPath: AUTH_PATH }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
          '--no-first-run',
          '--disable-extensions',
          '--disable-dev-shm-usage',
        ],
      },
      // Spoof a real Chrome user agent so WhatsApp doesn't block the headless browser
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

    this._client.on('ready', () => {
      this._connected = true;
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

      // Detect and parse button interaction responses.
      // buttons_response  → user tapped a quick-reply button
      // list_response     → user selected a row from a list message
      let buttonInteraction = null;
      if (msg.type === 'buttons_response') {
        buttonInteraction = {
          type: 'quick_reply',
          buttonId: msg.selectedButtonId || null,
          title: msg.body ? msg.body.trim() : null,
        };
      } else if (msg.type === 'list_response') {
        buttonInteraction = {
          type: 'list',
          rowId: msg.selectedRowId || null,
          title: msg.body ? msg.body.trim() : null,
        };
      }

      const normalized = buildMessage({
        userId,
        text: msg.body ? msg.body.trim() : '',
        receivedAt: new Date(msg.timestamp * 1000),
        media,
        links,
      });

      // Attach button interaction data so downstream handlers can route
      // button selections without re-parsing free text.
      normalized.buttonInteraction = buttonInteraction;

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
   * @param {string} userId   - WhatsApp chat ID (e.g. "447911123456@c.us")
   * @param {string} filePath - Absolute path to the file on disk
   * @param {string} mimeType - MIME type of the file (e.g. "application/pdf")
   * @param {string} caption  - Optional caption sent alongside the document
   */
  async sendDocument(userId, filePath, mimeType, caption = '') {
    if (!this._connected) {
      throw new Error('[WhatsApp] Cannot send — not connected');
    }
    const fileData = fs.readFileSync(filePath);
    const base64Data = fileData.toString('base64');
    const filename = path.basename(filePath);
    const media = new MessageMedia(mimeType, base64Data, filename);
    await this._client.sendMessage(userId, media, { caption, sendMediaAsDocument: true });
  }

  getStatus() {
    return {
      connected: this._connected,
      provider: 'whatsapp',
    };
  }
}

module.exports = { WhatsAppProvider };
