const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { MessagingLayer, buildMessage } = require('./MessagingLayer');

const AUTH_PATH = path.resolve('./.baileys_auth_business');

/**
 * WhatsApp implementation of MessagingLayer via Baileys.
 * Drop-in replacement for the whatsapp-web.js WhatsAppProvider.
 * No headless Chrome — connects via WhatsApp's native WebSocket protocol.
 */
class WhatsAppProvider extends MessagingLayer {
  constructor() {
    super();
    this._sock = null;
    this._messageCallback = null;
    this._connected = false;
    this._qrShown = false;
  }

  async connect() {
    console.log('[WhatsApp] Initializing...');
    await this._initSocket();
  }

  async _initSocket() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();

    this._sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: require('pino')({ level: 'silent' }),
      browser: ['ArthaOS', 'Chrome', '122.0.0'],
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
      retryRequestDelayMs: 2000,
    });

    this._sock.ev.on('creds.update', saveCreds);

    this._sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (!this._qrShown) {
          console.log('\nScan this QR code with WhatsApp to authenticate:\n');
          qrcode.generate(qr, { small: true });
          this._qrShown = true;
        }
      }

      if (connection === 'open') {
        this._connected = true;
        this._qrShown = false;
        console.log('[WhatsApp] Connected and ready.');
      }

      if (connection === 'close') {
        this._connected = false;
        const statusCode = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : null;
        const reason = DisconnectReason[statusCode] || statusCode;
        console.warn('[WhatsApp] Disconnected:', reason);

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (!shouldReconnect) {
          console.warn('[WhatsApp] Session logged out — clearing auth and exiting for QR re-scan.');
          try { fs.rmSync(AUTH_PATH, { recursive: true, force: true }); } catch {}
          process.exit(1);
        }

        // Reconnect after delay
        const delay = statusCode === DisconnectReason.restartRequired ? 2000 : 15000;
        console.log(`[WhatsApp] Reconnecting in ${delay / 1000}s...`);
        setTimeout(() => this._initSocket(), delay);
      }
    });

    this._sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;

        const userId = msg.key.remoteJid;
        const text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.imageMessage?.caption
          || msg.message?.documentMessage?.caption
          || '';

        if (!text.trim()) continue;

        const normalized = buildMessage({
          userId,
          text: text.trim(),
          receivedAt: new Date((msg.messageTimestamp ?? Date.now() / 1000) * 1000),
          media: [],
          links: [],
        });

        this._dispatchMessage(normalized);
      }
    });
  }

  async disconnect() {
    if (this._sock) {
      await this._sock.logout().catch(() => {});
      this._sock.end();
    }
    this._connected = false;
    console.log('[WhatsApp] Disconnected.');
  }

  onMessage(callback) {
    this._messageCallback = callback;
  }

  async sendMessage(userId, text) {
    if (!this._connected || !this._sock) {
      throw new Error('[WhatsApp] Cannot send — not connected');
    }
    await this._sock.sendMessage(userId, { text });
  }

  // Baileys doesn't support interactive buttons/lists on personal WhatsApp
  // — fall back to plain text for these
  async sendQuickReply(userId, quickReply) {
    const { payload } = quickReply;
    const buttons = payload.action.buttons.map(b => `• ${b.reply.title}`).join('\n');
    const text = `${payload.body.text}\n\n${buttons}`;
    await this.sendMessage(userId, text);
  }

  async sendListMessage(userId, listMessage) {
    const { payload } = listMessage;
    const items = payload.action.sections
      .flatMap(s => s.rows.map(r => `• ${r.title}`))
      .join('\n');
    const text = `${payload.body.text}\n\n${items}`;
    await this.sendMessage(userId, text);
  }

  async sendDocument(userId, attachment) {
    if (!this._connected || !this._sock) {
      throw new Error('[WhatsApp] Cannot send — not connected');
    }
    const { mimeType, data, filename, caption = '' } = attachment;
    const buffer = Buffer.from(data, 'base64');
    await this._sock.sendMessage(userId, {
      document: buffer,
      mimetype: mimeType,
      fileName: filename,
      caption,
    });
  }

  async sendFileAttachment(to, filePath) {
    if (!this._connected || !this._sock) {
      throw new Error('[WhatsApp] Cannot send — not connected');
    }
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();
    const MIME_MAP = {
      '.pdf': 'application/pdf', '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.txt': 'text/plain', '.csv': 'text/csv',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.zip': 'application/zip', '.json': 'application/json',
    };
    const mimeType = MIME_MAP[ext] || 'application/octet-stream';
    const buffer = fs.readFileSync(filePath);
    await this._sock.sendMessage(to, {
      document: buffer,
      mimetype: mimeType,
      fileName: filename,
    });
  }

  getStatus() {
    return { connected: this._connected, provider: 'whatsapp-baileys' };
  }
}

module.exports = { WhatsAppProvider };
