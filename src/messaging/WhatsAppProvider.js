const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
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
      if (!this._messageCallback) return;
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

      this._messageCallback(buildMessage({
        userId,
        text: msg.body ? msg.body.trim() : '',
        receivedAt: new Date(msg.timestamp * 1000),
        media,
        links,
      }));
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

  getStatus() {
    return {
      connected: this._connected,
      provider: 'whatsapp',
    };
  }
}

module.exports = { WhatsAppProvider };
