'use strict';

const WebSocket = require('ws');
const protocol = require('./protocol');

const GAME_WS_HOST = '172.18.0.3';

class GameClient {
  constructor(actualToken, options = {}) {
    this.actualToken = actualToken;
    this.connectTimeout = options.connectTimeout || 15000;
    this.heartbeatMs = options.heartbeatMs || 5000;
    this.ws = null;
    this.connected = false;
    this.ack = 0;
    this.seq = 1; // Must start at 1; server silently drops seq=0 packets
    this.promises = {}; // seq -> { resolve, reject, timer }
    this.enc = protocol.getEnc('x');
    this.autoEnc = protocol.getEnc('auto'); // passthrough for incoming
    this.heartbeatTimer = null;
    this.log = options.log || (() => {});
  }

  /**
   * Connect to the game WebSocket server.
   * Resolves when the connection is open, rejects on timeout or error.
   */
  connect() {
    return new Promise((resolve, reject) => {
      const isProxy = (GAME_WS_HOST === '172.18.0.3');
      const url = isProxy
        ? `ws://${GAME_WS_HOST}/ws-proxy/agent?p=${encodeURIComponent(this.actualToken)}&e=x&lang=chinese`
        : `wss://${GAME_WS_HOST}/agent?p=${encodeURIComponent(this.actualToken)}&e=x&lang=chinese`;

      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        if (err) reject(err);
        else resolve();
      };

      const timeoutHandle = setTimeout(() => {
        settle(new Error(`Connection timeout after ${this.connectTimeout}ms`));
        try { this.ws && this.ws.terminate(); } catch {}
      }, this.connectTimeout);

      try {
        this.ws = new WebSocket(url, { rejectUnauthorized: false });
      } catch (err) {
        settle(err);
        return;
      }

      this.ws.on('open', () => {
        this.connected = true;
        this.log('WebSocket connection opened');
        this._startHeartbeat();
        settle(null);
      });

      this.ws.on('message', (data) => {
        this._handleMessage(data);
      });

      this.ws.on('error', (err) => {
        this.log(`WebSocket error: ${err.message}`, 'error');
        if (!settled) {
          settle(err);
        }
        this._rejectAllPending(err);
      });

      this.ws.on('close', (code, reason) => {
        this.connected = false;
        this._stopHeartbeat();
        const msg = `WebSocket closed (code=${code})`;
        this.log(msg);
        if (!settled) {
          settle(new Error(msg));
        }
        this._rejectAllPending(new Error(msg));
      });
    });
  }

  /**
   * Gracefully close the WebSocket connection.
   */
  disconnect() {
    this._stopHeartbeat();
    this._rejectAllPending(new Error('Client disconnected'));
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  /**
   * Send a command without waiting for a response (fire and forget).
   */
  send(cmd, params = {}) {
    if (!this.ws || !this.connected) {
      this.log(`Cannot send "${cmd}": not connected`, 'error');
      return;
    }
    try {
      // Pass raw params to protocol.encode - it will BON-encode automatically
      // Do NOT pre-encode bodyBytes, as protocol.encode will re-encode them
      const packet = {
        cmd,
        ack: this.ack,
        seq: this.seq++,
        time: Date.now(),
        body: params,
      };
      const encoded = protocol.encode(packet, this.enc);
      this.ws.send(Buffer.from(encoded));
    } catch (err) {
      this.log(`Send error for "${cmd}": ${err.message}`, 'error');
    }
  }

  /**
   * Send a command and return a Promise that resolves with the server response body.
   * The promise is matched by seq/ack: server responds with { ack: ourSeq, code: 0, body: ... }
   */
  sendWithPromise(cmd, params = {}, timeout = 8000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        return reject(new Error(`Cannot send "${cmd}": not connected`));
      }

      const seq = this.seq;

      // Pass raw params to protocol.encode - it will BON-encode the body automatically
      // Do NOT pre-encode bodyBytes, as protocol.encode will re-encode them
      const packet = {
        cmd,
        ack: this.ack,
        seq: this.seq++,
        time: Date.now(),
        body: params,
      };

      let encoded;
      try {
        encoded = protocol.encode(packet, this.enc);
      } catch (err) {
        return reject(new Error(`Failed to encode packet for "${cmd}": ${err.message}`));
      }

      const timer = setTimeout(() => {
        delete this.promises[seq];
        reject(new Error(`Timeout waiting for response to "${cmd}" (seq=${seq})`));
      }, timeout);

      this.promises[seq] = { resolve, reject, timer };

      try {
        this.ws.send(Buffer.from(encoded));
      } catch (err) {
        clearTimeout(timer);
        delete this.promises[seq];
        reject(err);
      }
    });
  }

  /**
   * Handle an incoming binary message from the server.
   */
  _handleMessage(data) {
    try {
      // Convert Buffer to Uint8Array
      const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

      // Auto-detect and decrypt
      const autoEnc = protocol.getEnc('auto');
      const plain = autoEnc.decrypt(new Uint8Array(u8)); // pass a copy so decrypt can mutate
      const packet = protocol.bon.decode(plain);

      if (!packet || typeof packet !== 'object') return;

      // Update our ack from the server's seq
      if (packet.seq !== undefined && packet.seq !== null) {
        this.ack = packet.seq;
      }

      // Try to match a pending promise by the server's ack field
      const serverResp = packet.resp;
      if (serverResp !== undefined && serverResp !== null && this.promises[serverResp]) {
        const pending = this.promises[serverResp];
        clearTimeout(pending.timer);
        delete this.promises[serverResp];

        if (packet.code !== undefined && packet.code !== 0) {
          pending.reject(new Error(`Server error code ${packet.code} for resp=${serverResp}`));
          return;
        }

        // Decode the body if it's binary
        let responseBody = packet.body;
        if (responseBody instanceof Uint8Array) {
          try {
            responseBody = protocol.bon.decode(responseBody);
          } catch {
            // Leave as-is if decode fails
          }
        }

        pending.resolve(responseBody);
      }
    } catch (err) {
      this.log(`Message handling error: ${err.message}`, 'error');
    }
  }

  /**
   * Reject all pending promises (e.g., on disconnect or error).
   */
  _rejectAllPending(err) {
    for (const seq of Object.keys(this.promises)) {
      const pending = this.promises[seq];
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.promises = {};
  }

  /**
   * Start sending heartbeat packets every heartbeatMs milliseconds.
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || !this.connected) {
        this._stopHeartbeat();
        return;
      }
      try {
        // Pass raw body to protocol.encode - it will BON-encode automatically
        // Do NOT pre-encode body, as protocol.encode will re-encode it
        const heartbeat = {
          cmd: '_sys/ack',
          ack: this.ack,
          seq: this.seq++,
          time: Date.now(),
          body: {},
        };
        const encoded = protocol.encode(heartbeat, this.enc);
        this.ws.send(Buffer.from(encoded));
      } catch (err) {
        this.log(`Heartbeat error: ${err.message}`, 'error');
      }
    }, this.heartbeatMs);
  }

  /**
   * Stop the heartbeat timer.
   */
  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Promise-based delay helper.
   */
  delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = { GameClient };
