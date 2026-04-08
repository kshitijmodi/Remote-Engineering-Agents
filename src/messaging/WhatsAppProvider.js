const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { MessagingLayer } = require('./MessagingLayer');

const AUTH_PATH = path.resolve('./.wwebjs_auth_stable');

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

    // message_create fires for ALL messages including ones you send to yourself.
    // message only fires for incoming messages from others.
    // We use message_create so the user can control the bot by messaging themselves.
    // message_create fires for all messages including self-messages (personal number setup).
    // message only fires for incoming from others (Business number setup).
    // We handle both and filter correctly by origin.
    // Personal number setup: user messages themselves.
    // Only process message_create where:
    //   - sent by the user (fromMe=true)
    //   - sent TO the @lid (the linked device = self-chat only)
    // This ensures messages to OTHER people never reach the bot.
    this._client.on('message_create', (msg) => {
      if (!this._messageCallback) return;
      if (msg.type !== 'chat') return;
      if (!msg.fromMe) return;
      // Only self-messages: sent by user's phone (@c.us) TO their own linked device (@lid)
      if (!msg.from.endsWith('@c.us')) return;  // ignore bot responses (from @lid)
      if (!msg.to.endsWith('@lid')) return;      // ignore messages to other contacts

      const userId = msg.from;
      console.log(`[WhatsApp] Self-message from ${userId}: "${msg.body?.slice(0, 60)}"`);

      this._messageCallback({
        userId,
        text: msg.body.trim(),
        receivedAt: new Date(msg.timestamp * 1000),
        _raw: msg,
      });
    });

    // Business number setup: incoming messages from other people.
    // fromMe=false means someone else sent this — safe, no self-loop risk.
    this._client.on('message', (msg) => {
      if (!this._messageCallback) return;
      if (msg.type !== 'chat') return;
      if (msg.fromMe) return; // handled above

      const userId = msg.from;
      console.log(`[WhatsApp] Incoming from ${userId}: "${msg.body?.slice(0, 60)}"`);

      this._messageCallback({
        userId,
        text: msg.body.trim(),
        receivedAt: new Date(msg.timestamp * 1000),
        _raw: msg,
      });
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
