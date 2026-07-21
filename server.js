import { createRequire } from 'module';
import fs from 'fs';
import { join } from 'path';

const require = createRequire(import.meta.url);

function debugLog(msg) {
  const time = new Date().toISOString();
  try {
    fs.appendFileSync(join(process.cwd(), 'request_debug.log'), `[${time}] ${msg}\n`);
  } catch (err) {}
}
const Module = require('module');
const originalLoad = Module._load;

class PreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.trim().replace(/\s+/g, ' ');
  }

  run(...args) {
    if (args.length === 1 && Array.isArray(args[0])) {
      args = args[0];
    }
    const result = this.execute(args);
    this.db.save();
    return { changes: result.changes || 0, lastInsertRowid: result.lastInsertRowid || 0 };
  }

  get(...args) {
    if (args.length === 1 && Array.isArray(args[0])) {
      args = args[0];
    }
    const rows = this.execute(args);
    return rows.length > 0 ? rows[0] : undefined;
  }

  all(...args) {
    if (args.length === 1 && Array.isArray(args[0])) {
      args = args[0];
    }
    return this.execute(args);
  }

  execute(args) {
    const sql = this.sql;
    
    if (sql.toUpperCase().startsWith('INSERT') || sql.toUpperCase().startsWith('REPLACE')) {
      const match = sql.match(/(?:INSERT|INSERT OR REPLACE|REPLACE)\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
      if (match) {
        const table = match[1].toLowerCase();
        const columns = match[2].split(',').map(s => s.trim());
        if (!this.db.data[table]) this.db.data[table] = [];
        
        const row = {};
        columns.forEach((col, idx) => {
          row[col] = args[idx];
        });
        
        if (row.id) {
          const existingIdx = this.db.data[table].findIndex(r => r.id === row.id);
          if (existingIdx !== -1) {
            this.db.data[table][existingIdx] = { ...this.db.data[table][existingIdx], ...row };
            return { changes: 1, lastInsertRowid: existingIdx + 1 };
          }
        }
        
        this.db.data[table].push(row);
        return { changes: 1, lastInsertRowid: this.db.data[table].length };
      }
    }
    
    if (sql.toUpperCase().startsWith('UPDATE')) {
      const match = sql.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/i);
      if (match) {
        const table = match[1].toLowerCase();
        const setPart = match[2];
        const wherePart = match[3];
        
        if (!this.db.data[table]) this.db.data[table] = [];
        
        const updates = setPart.split(',').map(s => s.trim());
        let rowsToUpdate = this.db.data[table];
        
        const setPlaceholdersCount = (setPart.match(/\?/g) || []).length;
        const setArgs = args.slice(0, setPlaceholdersCount);
        const whereArgs = args.slice(setPlaceholdersCount);
        
        let changesCount = 0;
        rowsToUpdate.forEach(row => {
          if (this.evalConditions(row, wherePart, whereArgs)) {
            let setArgIdx = 0;
            updates.forEach(update => {
              const parts = update.split('=');
              const col = parts[0].trim();
              const valExpr = parts[1].trim();
              
              if (valExpr === '?') {
                row[col] = setArgs[setArgIdx++];
              } else if (valExpr.includes('+')) {
                row[col] = (row[col] || 0) + 1;
              } else {
                row[col] = JSON.parse(valExpr);
              }
            });
            changesCount++;
          }
        });
        return { changes: changesCount };
      }
    }
    
    if (sql.toUpperCase().startsWith('DELETE FROM')) {
      const match = sql.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/i);
      if (match) {
        const table = match[1].toLowerCase();
        const wherePart = match[2];
        
        if (!this.db.data[table]) this.db.data[table] = [];
        
        const initialLength = this.db.data[table].length;
        this.db.data[table] = this.db.data[table].filter(row => !this.evalConditions(row, wherePart, args));
        return { changes: initialLength - this.db.data[table].length };
      }
    }
    
    if (sql.toUpperCase().startsWith('SELECT')) {
      const countMatch = sql.match(/SELECT\s+COUNT\(\*\)\s+as\s+count\s+FROM\s+(\w+)/i);
      if (countMatch) {
        const table = countMatch[1].toLowerCase();
        const count = this.db.data[table] ? this.db.data[table].length : 0;
        return [{ count }];
      }
      
      const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(\d+))?$/i);
      if (selectMatch) {
        const columnsStr = selectMatch[1];
        const table = selectMatch[2].toLowerCase();
        const wherePart = selectMatch[3];
        const orderByPart = selectMatch[4];
        const limitVal = selectMatch[5] ? parseInt(selectMatch[5], 10) : null;
        
        let rows = this.db.data[table] ? JSON.parse(JSON.stringify(this.db.data[table])) : [];
        
        if (wherePart) {
          rows = rows.filter(row => this.evalConditions(row, wherePart, args));
        }
        
        if (orderByPart) {
          const parts = orderByPart.trim().split(/\s+/);
          const orderCol = parts[0];
          const isDesc = orderByPart.toLowerCase().includes('desc');
          rows.sort((a, b) => {
            let valA = orderCol === 'rowid' ? (a.rowid !== undefined ? a.rowid : rows.indexOf(a)) : a[orderCol];
            let valB = orderCol === 'rowid' ? (b.rowid !== undefined ? b.rowid : rows.indexOf(b)) : b[orderCol];
            if (valA < valB) return isDesc ? 1 : -1;
            if (valA > valB) return isDesc ? -1 : 1;
            return 0;
          });
        }
        
        if (limitVal !== null) {
          rows = rows.slice(0, limitVal);
        }
        
        if (columnsStr.trim() !== '*') {
          const projectCols = columnsStr.split(',').map(s => s.trim());
          rows = rows.map(row => {
            const projected = {};
            projectCols.forEach(col => {
              projected[col] = row[col];
            });
            return projected;
          });
        }
        
        return rows;
      }
    }
    
    return [];
  }

  evalConditions(row, wherePart, args) {
    if (!wherePart) return true;
    
    let placeholderIdx = 0;
    
    if (wherePart.trim() === 'ip = ?') return row.ip === args[0];
    if (wherePart.trim() === 'id = ?') return row.id === args[0];
    if (wherePart.trim() === 'username = ?') return row.username === args[0];
    if (wherePart.trim() === 'user_id = ?') return row.user_id === args[0];
    if (wherePart.trim() === 'jid = ?') return row.jid === args[0];
    if (wherePart.trim() === 'remote_jid = ?') return row.remote_jid === args[0];
    if (wherePart.trim() === 'id = ? AND user_id = ?') return row.id === args[0] && row.user_id === args[1];
    
    let expr = wherePart
      .replace(/AND/gi, '&&')
      .replace(/OR/gi, '||')
      .replace(/IS NULL/gi, '== null')
      .replace(/IS NOT NULL/gi, '!= null')
      .replace(/=/g, '==')
      .replace(/===/g, '==');
      
    while (expr.includes('?')) {
      const val = args[placeholderIdx++];
      const serializedVal = typeof val === 'string' ? `"${val.replace(/"/g, '\\"')}"` : val;
      expr = expr.replace('?', serializedVal);
    }
    
    try {
      const func = new Function('row', `
        with(row) {
          try {
            return !!(${expr});
          } catch(e) {
            return false;
          }
        }
      `);
      return func(row);
    } catch (e) {
      return false;
    }
  }
}

class JsonSqliteDb {
  constructor(filepath) {
    this.filepath = filepath.replace(/\.db$/, '.json');
    this.data = {
      security_users: [],
      security_credentials: [],
      security_sessions: [],
      security_rate_limits: [],
      incoming_messages: [],
      chat_threads: [],
      automation_webhooks: [],
      auto_responders: [],
      contacts: [],
      messages: []
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filepath)) {
        const fileContent = fs.readFileSync(this.filepath, 'utf8');
        if (fileContent.trim().startsWith('{')) {
          this.data = JSON.parse(fileContent);
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  save() {
    try {
      fs.writeFileSync(this.filepath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.error(e);
    }
  }

  exec(sql) {
    this.save();
  }

  prepare(sql) {
    return new PreparedStatement(this, sql);
  }
}

// Register global module load interceptor
Module._load = function (request, parent, isMain) {
  if (request === 'better-sqlite3') {
    return JsonSqliteDb;
  }
  return originalLoad.apply(this, arguments);
};

// Defer other imports to execute after interceptor is active
const { default: http } = await import('http');
const { default: path } = await import('path');
const { URL } = await import('url');
const { rm } = await import('fs/promises');
const { default: BerryProtocol } = await import('./dist/index.js');
const { generateWAMessageFromContent } = await import('@berrysdk/transport');
const { default: pino } = await import('pino');
const { default: qrcode } = await import('qrcode');
const { default: crypto } = await import('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = await import('@simplewebauthn/server');

process.on('uncaughtException', (err) => {
  console.error('[Fatal Uncaught Exception]', err);
  try {
    fs.writeFileSync(join(process.cwd(), 'error_boot.log'), `Uncaught Exception: ${err.stack || err}\n`, { flag: 'a' });
  } catch (_) {}
});

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});

const dbPath = join(process.cwd(), 'berrysdk.db');
let securityDb;
try {
  const Database = require('better-sqlite3');
  securityDb = new Database(dbPath);

  // Initialize security tables
  securityDb.exec(`
    CREATE TABLE IF NOT EXISTS security_users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      totp_secret TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS security_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      sign_counter INTEGER NOT NULL,
      transports TEXT,
      FOREIGN KEY(user_id) REFERENCES security_users(id)
    );
    CREATE TABLE IF NOT EXISTS security_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      revoked INTEGER DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES security_users(id)
    );
    CREATE TABLE IF NOT EXISTS security_rate_limits (
      ip TEXT PRIMARY KEY,
      attempts INTEGER DEFAULT 0,
      last_attempt DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS incoming_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      jid TEXT NOT NULL,
      sender_name TEXT,
      message_text TEXT,
      message_type TEXT DEFAULT 'text',
      from_me INTEGER DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      raw_json TEXT
    );
    CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      jid TEXT NOT NULL,
      name TEXT,
      last_message TEXT,
      last_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      unread_count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS automation_webhooks (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      url TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS auto_responders (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      keyword TEXT NOT NULL,
      match_type TEXT DEFAULT 'contains',
      reply_text TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    DELETE FROM security_users WHERE username = 'testadmin';
    DELETE FROM security_sessions;
  `);
} catch (err) {
  console.error('[DB Error] Failed to initialize security database:', err);
  try {
    fs.writeFileSync(join(process.cwd(), 'error_boot.log'), `DB Init Error: ${err.stack || err}\n`, { flag: 'a' });
  } catch (_) {}
}

// In-memory store for active challenges (WebAuthn / setup / login states)
const activeChallenges = new Map();

// Helper: Hashing passwords with scrypt
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const verifyHash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return verifyHash === hash;
}

// Base32 Decoder
function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let cleaned = str.toUpperCase().replace(/[\s-]/g, '');
  let bits = '';
  let buffer = [];

  for (let i = 0; i < cleaned.length; i++) {
    const val = alphabet.indexOf(cleaned[i]);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }

  for (let i = 0; i + 8 <= bits.length; i += 8) {
    buffer.push(parseInt(bits.substring(i, i + 8), 2));
  }

  return Buffer.from(buffer);
}

// HOTP Generator
function generateHOTP(secretBuffer, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter), 0);

  const hmac = crypto.createHmac('sha1', secretBuffer);
  hmac.update(buf);
  const hmacResult = hmac.digest();

  const offset = hmacResult[hmacResult.length - 1] & 0xf;
  const code = ((hmacResult[offset] & 0x7f) << 24) |
               ((hmacResult[offset + 1] & 0xff) << 16) |
               ((hmacResult[offset + 2] & 0xff) << 8) |
               (hmacResult[offset + 3] & 0xff);

  const token = code % 1000000;
  return token.toString().padStart(6, '0');
}

// TOTP Verification
function verifyTOTP(secret, token, window = 1) {
  try {
    const secretBuffer = base32Decode(secret);
    const epoch = Math.floor(Date.now() / 1000);
    const counter = Math.floor(epoch / 30);

    for (let i = -window; i <= window; i++) {
      if (generateHOTP(secretBuffer, counter + i) === token) {
        return true;
      }
    }
  } catch (err) {
    console.error('[TOTP] Verification error:', err);
  }
  return false;
}

// Cookie parser helper
function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return list;
}

// Rate Limiter
function checkRateLimit(ip) {
  const now = new Date();
  const row = securityDb.prepare('SELECT attempts, last_attempt FROM security_rate_limits WHERE ip = ?').get(ip);
  if (row) {
    const lastAttempt = new Date(row.last_attempt);
    if (now - lastAttempt > 15 * 60 * 1000) {
      securityDb.prepare('UPDATE security_rate_limits SET attempts = 0, last_attempt = ? WHERE ip = ?').run(now.toISOString(), ip);
      return true;
    }
    if (row.attempts >= 5) {
      return false;
    }
  }
  return true;
}

function incrementRateLimit(ip) {
  const now = new Date();
  const row = securityDb.prepare('SELECT attempts FROM security_rate_limits WHERE ip = ?').get(ip);
  if (row) {
    securityDb.prepare('UPDATE security_rate_limits SET attempts = attempts + 1, last_attempt = ? WHERE ip = ?').run(now.toISOString(), ip);
  } else {
    securityDb.prepare('INSERT INTO security_rate_limits (ip, attempts, last_attempt) VALUES (?, 1, ?)').run(ip, now.toISOString());
  }
}

function resetRateLimit(ip) {
  securityDb.prepare('DELETE FROM security_rate_limits WHERE ip = ?').run(ip);
}

// WebAuthn configuration helper
function getWebAuthnConfig(req) {
  const host = req.headers.host || 'localhost';
  const domain = host.split(':')[0];
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return {
    rpName: 'WazoneIndia Suite',
    rpID: domain,
    origin: `${proto}://${host}`
  };
}

// Deterministic API Key and Token derivation
function getSessionKeys(sessionId) {
  const salt = 'wazoneindia_secret_salt_2026';
  const hashKey = crypto.createHmac('sha256', salt).update(`${sessionId}_apikey`).digest('hex');
  const hashToken = crypto.createHmac('sha256', salt).update(`${sessionId}_apitoken`).digest('hex');
  return {
    apiKey: `wz_key_${hashKey.substring(0, 16)}`,
    apiToken: `wz_tok_${hashToken.substring(0, 32)}`
  };
}

function createAndSetSession(res, req, userId) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  securityDb.prepare('INSERT INTO security_sessions (id, user_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sessionToken, userId, req.socket?.remoteAddress || '127.0.0.1', req.headers['user-agent'] || '', expiresAt.toISOString());

  res.setHeader('Set-Cookie', `wz_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}; Secure`);
}

// Verify that the request has the correct API key/token for the given session ID or valid admin session
function isAuthorized(req, parsedUrl, sessionId, currentUser) {
  if (currentUser) return true;
  if (!sessionId) return false;
  
  const keys = getSessionKeys(sessionId);
  const providedKey = req.headers['x-api-key'] || 
                      parsedUrl?.searchParams?.get('apiKey') || 
                      parsedUrl?.searchParams?.get('token');
  
  if (!providedKey) {
    console.error(`[Auth Failed] Request targeting session "${sessionId}" is missing x-api-key header or query parameter.`);
    return false; 
  }
  
  const isValid = providedKey === keys.apiKey || providedKey === keys.apiToken;
  if (!isValid) {
    console.error(`[Auth Failed] Request targeting session "${sessionId}" provided invalid key: ${providedKey}`);
  }
  return isValid;
}


const logger = pino({ level: 'info' });
const clients = new Map();

// --- LIVE CHAT & AUTOMATION ENGINE ---
const sseClients = new Set();

function broadcastSSE(event, data) {
  const payloadData = JSON.stringify({ event, ...data });
  const payload = `data: ${payloadData}\n\nevent: ${event}\ndata: ${payloadData}\n\n`;
  for (const clientRes of sseClients) {
    try {
      clientRes.write(payload);
    } catch (_) {
      sseClients.delete(clientRes);
    }
  }
}

function extractMessageText(msg) {
  if (!msg || !msg.message) return '';
  const m = msg.message;
  return m.conversation ||
         m.extendedTextMessage?.text ||
         m.imageMessage?.caption ||
         m.videoMessage?.caption ||
         m.documentMessage?.caption ||
         m.buttonsResponseMessage?.selectedDisplayText ||
         m.buttonsResponseMessage?.selectedButtonId ||
         m.listResponseMessage?.title ||
         m.listResponseMessage?.singleSelectReply?.selectedRowId ||
         (m.pollCreationMessage ? `[Poll] ${m.pollCreationMessage.name}` : '') ||
         (m.imageMessage ? '[Photo]' : '') ||
         (m.videoMessage ? '[Video]' : '') ||
         (m.audioMessage ? '[Audio]' : '') ||
         (m.documentMessage ? '[Document]' : '') ||
         (m.stickerMessage ? '[Sticker]' : '') ||
         '';
}

function extractMessageType(msg) {
  if (!msg || !msg.message) return 'text';
  const m = msg.message;
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage) return 'audio';
  if (m.documentMessage) return 'document';
  if (m.pollCreationMessage) return 'poll';
  if (m.stickerMessage) return 'sticker';
  return 'text';
}

async function triggerWebhooks(sessionId, messagePayload) {
  try {
    const rows = securityDb.prepare("SELECT url FROM automation_webhooks WHERE active = 1 AND (session_id = ? OR session_id IS NULL OR session_id = '')").all(sessionId);
    for (const row of rows) {
      fetch(row.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'messages.upsert',
          sessionId,
          timestamp: new Date().toISOString(),
          message: messagePayload
        })
      }).catch(err => console.error(`[Webhook Error] Failed to post to ${row.url}:`, err.message));
    }
  } catch (err) {
    console.error('[Webhook Dispatch Error]', err.message);
  }
}

const processedAutoResponderMsgIds = new Set();

async function triggerAutoResponders(sessionId, client, messagePayload) {
  if (!messagePayload || !messagePayload.id) return;
  
  if (processedAutoResponderMsgIds.has(messagePayload.id)) {
    console.log(`[Auto-Responder] Deduplicated duplicate message trigger for ID: ${messagePayload.id}`);
    return;
  }
  processedAutoResponderMsgIds.add(messagePayload.id);
  if (processedAutoResponderMsgIds.size > 5000) {
    const firstKey = processedAutoResponderMsgIds.values().next().value;
    processedAutoResponderMsgIds.delete(firstKey);
  }

  console.log(`[Auto-Responder Debug] Called for session=${sessionId}, jid=${messagePayload.jid}, text="${messagePayload.text}", fromMe=${messagePayload.fromMe}`);
  if (messagePayload.fromMe || !messagePayload.text) {
    console.log(`[Auto-Responder Debug] Skipped because fromMe=${messagePayload.fromMe} or text is empty.`);
    return;
  }
  try {
    const textLower = messagePayload.text.trim().toLowerCase();
    const rules = securityDb.prepare("SELECT * FROM auto_responders WHERE active = 1 AND (session_id = ? OR session_id IS NULL OR session_id = '')").all(sessionId);
    console.log(`[Auto-Responder Debug] Active rules count: ${rules.length}`, rules);
    
    for (const rule of rules) {
      const kwLower = rule.keyword.trim().toLowerCase();
      let isMatch = false;

      if (rule.match_type === 'exact') {
        isMatch = (textLower === kwLower);
      } else if (rule.match_type === 'starts_with') {
        isMatch = textLower.startsWith(kwLower);
      } else { // default 'contains'
        isMatch = textLower.includes(kwLower);
      }

      console.log(`[Auto-Responder Debug] Rule keyword: "${rule.keyword}" (${rule.match_type}), Incoming: "${textLower}", Match: ${isMatch}`);

      if (isMatch) {
        console.log(`[Auto-Responder] Match found for keyword "${rule.keyword}" in session "${sessionId}" from ${messagePayload.jid}`);
        
        let replyMsgId = `auto_${Date.now()}`;
        if (client && (client.connected || client.authorized)) {
          try {
            console.log(`[Auto-Responder] Sending reply via client.sendText to ${messagePayload.jid}...`);
            const replyRes = await client.sendText(messagePayload.jid, rule.reply_text);
            replyMsgId = replyRes?.id || replyRes?.key?.id || replyMsgId;
            console.log(`[Auto-Responder] Reply sent successfully! MessageId: ${replyMsgId}`);
          } catch (sendErr) {
            console.error('[Auto-Responder Send Error]', sendErr.message);
          }
        } else {
          console.warn(`[Auto-Responder Warning] Client not connected for session ${sessionId}, saving local reply record.`);
        }

        const replyRecord = {
          id: replyMsgId,
          sessionId,
          jid: messagePayload.jid,
          senderName: 'Auto Bot',
          text: rule.reply_text,
          type: 'text',
          fromMe: true,
          timestamp: new Date().toISOString()
        };

        saveMessageRecord(replyRecord);
        broadcastSSE('message', replyRecord);
        break;
      }
    }
  } catch (err) {
    console.error('[Auto-Responder Error]', err.message);
  }
}

function saveMessageRecord(rec) {
  try {
    const threadId = `${rec.sessionId}:${rec.jid}`;
    const unreadInc = rec.fromMe ? 0 : 1;

    securityDb.prepare(`
      INSERT OR REPLACE INTO incoming_messages (id, session_id, jid, sender_name, message_text, message_type, from_me, timestamp, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(rec.id, rec.sessionId, rec.jid, rec.senderName||'', rec.text||'', rec.type||'text', rec.fromMe ? 1 : 0, rec.timestamp, JSON.stringify(rec));

    const existingThread = securityDb.prepare('SELECT unread_count FROM chat_threads WHERE id = ?').get(threadId);
    const newUnread = (existingThread ? existingThread.unread_count : 0) + unreadInc;

    securityDb.prepare(`
      INSERT INTO chat_threads (id, session_id, jid, name, last_message, last_timestamp, unread_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_message = excluded.last_message,
        last_timestamp = excluded.last_timestamp,
        unread_count = ?,
        name = COALESCE(NULLIF(excluded.name, ''), name)
    `).run(threadId, rec.sessionId, rec.jid, rec.senderName||rec.jid.split('@')[0], rec.text||`[${rec.type}]`, rec.timestamp, newUnread, newUnread);

  } catch (err) {
    console.error('[DB Save Message Error]', err.message);
  }
}

// Helper to get or create client session
async function getOrCreateClient(sessionId) {
  if (clients.has(sessionId)) {
    return clients.get(sessionId);
  }
  
  console.log(`[Server] Initializing WhatsApp client session: ${sessionId}...`);
  const client = new BerryProtocol({
    sessionId,
    logger,
    reconnectMaxAttempts: 5,
    reconnectDelayMs: 3000
  });
  
  // Track status
  client.connected = false;
  client.qrCode = null;
  client.pairingCode = null;
  client.authorized = false;
  client.on('connection.open', () => {
    console.log(`[Server] Connection opened for session: ${sessionId}`);
    client.connected = true;
  });
  client.on('connection.close', () => {
    console.log(`[Server] Connection closed for session: ${sessionId}`);
    client.connected = false;
    if (client.authorized && !client._manualMode) {
      console.log(`[Server] Session ${sessionId} was authorized, reconnecting...`);
      client.reconnect().catch(err => {
        console.error(`[Server] Auto-reconnect failed:`, err.message);
      });
    }
  });
  client.on('auth.success', () => {
    console.log(`[Server] Auth success for session: ${sessionId}`);
    client.connected = true;
    client.authorized = true;
  });
  client.on('auth.qr', ({ value }) => {
    console.log(`[Server] QR received for session: ${sessionId}`);
    client.qrCode = value;
  });
  client.on('auth.pairing_code', ({ code, phoneNumber }) => {
    console.log(`[Server] Pairing code for ${phoneNumber}: ${code}`);
    client.pairingCode = code;
  });
  client.on('connection.reconnecting', ({ attempt, delayMs }) => {
    console.log(`[Server] Reconnecting... attempt ${attempt}, delay ${delayMs}ms`);
  });

  // Helper to handle normalized message objects
  const handleNormalizedMessage = (msg, isOutgoing = false) => {
    if (!msg) return;
    const jid = msg.remoteJid || msg.to || msg.chatId || msg.from;
    if (!jid || jid === 'status@broadcast') return;

    const fromMe = isOutgoing ? true : (msg.fromMe === true);
    const msgId = msg.id || `msg_${Date.now()}`;
    const senderName = msg.pushName || msg.senderName || (fromMe ? 'Me' : jid.split('@')[0]);
    const text = msg.text || msg.caption || (msg.type ? `[${msg.type}]` : '');
    const msgType = msg.type || 'text';
    const timestamp = msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString();

    const record = {
      id: msgId,
      sessionId,
      jid,
      senderName,
      text,
      type: msgType,
      fromMe,
      timestamp
    };

    saveMessageRecord(record);
    broadcastSSE('message', record);

    triggerWebhooks(sessionId, record);

    if (!fromMe) {
      triggerAutoResponders(sessionId, client, record);
    }
  };

  // BerryProtocol Event Bus Listeners
  client.on('message.received', (msg) => handleNormalizedMessage(msg, false));
  client.on('message.sent', (msg) => handleNormalizedMessage(msg, true));

  client.on('sync.messages', (messages) => {
    if (Array.isArray(messages)) {
      messages.forEach(m => handleNormalizedMessage(m, false));
    }
  });

  client.on('sync.history', ({ chats, contacts, messages }) => {
    if (Array.isArray(messages)) {
      messages.forEach(m => handleNormalizedMessage(m, false));
    }
  });

  // Baileys raw messages.upsert fallback
  client.on('messages.upsert', async ({ messages }) => {
    if (!messages || !Array.isArray(messages)) return;
    for (const msg of messages) {
      if (!msg.message || msg.key?.remoteJid === 'status@broadcast') continue;
      
      const jid = msg.key.remoteJid;
      const fromMe = Boolean(msg.key.fromMe);
      const msgId = msg.key.id || `msg_${Date.now()}`;
      const senderName = msg.pushName || (fromMe ? 'Me' : jid.split('@')[0]);
      const text = extractMessageText(msg);
      const msgType = extractMessageType(msg);
      const timestamp = new Date(msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now()).toISOString();

      const record = {
        id: msgId,
        sessionId,
        jid,
        senderName,
        text,
        type: msgType,
        fromMe,
        timestamp
      };

      saveMessageRecord(record);
      broadcastSSE('message', record);
      triggerWebhooks(sessionId, record);

      if (!fromMe) {
        triggerAutoResponders(sessionId, client, record);
      }
    }
  });

  // Restore authorized flag from database if previously connected
  try {
    const dbPath = join(process.cwd(), 'berrysdk.db');
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT payload FROM auth_sessions WHERE session_id = ?').get(sessionId);
      db.close();
      if (row) {
        const payload = JSON.parse(row.payload);
        if (payload.registered === true) {
          client.authorized = true;
          console.log(`[Server] Restored authorized flag for session: ${sessionId}`);
        }
      }
    }
  } catch {}

  // Bind raw Baileys messages.upsert listener directly to underlying WASocket when ready
  const attachRawSocketListener = () => {
    try {
      const sock = client.socket?.sock;
      if (sock && !sock._rawAutoResponderAttached) {
        sock._rawAutoResponderAttached = true;
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
          if (!messages || !Array.isArray(messages)) return;
          for (const msg of messages) {
            if (!msg.message || msg.key?.remoteJid === 'status@broadcast') continue;
            if (msg.key?.fromMe) continue;

            const jid = msg.key.remoteJid;
            const msgId = msg.key.id || `msg_${Date.now()}`;
            const senderName = msg.pushName || jid.split('@')[0];
            const text = extractMessageText(msg);
            const msgType = extractMessageType(msg);
            const timestamp = new Date(msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now()).toISOString();

            if (!text) continue;

            const record = {
              id: msgId,
              sessionId,
              jid,
              senderName,
              text,
              type: msgType,
              fromMe: false,
              timestamp
            };

            console.log(`[Server] Raw Baileys incoming message from ${jid} (session=${sessionId}): "${text}"`);
            saveMessageRecord(record);
            broadcastSSE('message', record);
            triggerWebhooks(sessionId, record);
            triggerAutoResponders(sessionId, client, record);
          }
        });
      }
    } catch (_) {}
  };

  client.on('connection.open', () => {
    console.log(`[Server] Connection opened for session: ${sessionId}`);
    client.connected = true;
    attachRawSocketListener();
  });

  // Periodic auth state monitor — checks socket creds every 5s
  if (!client._authMonitor) {
    client._authMonitor = setInterval(() => {
      attachRawSocketListener();
      if (client.authorized || client.connected) {
        return;
      }
      try {
        const sock = client.socket?.sock;
        if (sock?.authState?.creds?.registered && sock?.authState?.creds?.me?.id) {
          console.log(`[Server] Auth detected via polling for session: ${sessionId}`);
          client.connected = true;
          client.authorized = true;
          client.qrCode = null;
          console.log(`[Server] Marked session ${sessionId} as connected (via polling)`);
          attachRawSocketListener();
        }
      } catch {}
    }, 5000);
  }

  clients.set(sessionId, client);

  return client;
}

// Helper: check SQLite database for authenticated session
function isSessionRegisteredInDb(sessionId) {
  try {
    const dbPath = join(process.cwd(), 'berrysdk.db');
    if (!fs.existsSync(dbPath)) return false;
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT payload FROM auth_sessions WHERE session_id = ?').get(sessionId);
    db.close();
    if (!row) return false;
    const payload = JSON.parse(row.payload);
    return payload.registered === true;
  } catch { return false; }
}

// Helper: check if a client is truly authenticated
function isClientAuthenticated(client, sessionId) {
  if (!client) {
    // No in-memory client — check database
    return isSessionRegisteredInDb(sessionId);
  }
  // Fast path: our persistent authorized flag
  if (client.authorized) return true;
  if (client.connected) return true;
  // Check SDK-level auth credentials
  try {
    const creds = client.socket?.sock?.authState?.creds;
    if (creds?.me?.id) return true;
    if (creds?.registered) return true;
  } catch { /* ignore */ }
  // Fallback: check database
  return isSessionRegisteredInDb(sessionId);
}

const server = http.createServer(async (req, res) => {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const hostHeader = req.headers.host || 'localhost';
  const parsedUrl = new URL(req.url, `http://${hostHeader}`);
  const pathname = parsedUrl.pathname;

  // Resolve current user session
  const cookies = parseCookies(req);
  const sessionCookie = cookies['wz_session'];
  let currentUser = null;
  let currentSessionId = null;

  debugLog(`Incoming request: ${req.method} ${pathname} cookies=${JSON.stringify(cookies)}`);

  if (sessionCookie) {
    try {
      const sessionRow = securityDb.prepare('SELECT id, user_id FROM security_sessions WHERE id = ? AND revoked = 0 AND expires_at > ?').get(sessionCookie, new Date().toISOString());
      debugLog(`Resolved sessionRow: ${JSON.stringify(sessionRow || null)}`);
      if (sessionRow) {
        const userRow = securityDb.prepare('SELECT id, username FROM security_users WHERE id = ?').get(sessionRow.user_id);
        debugLog(`Resolved userRow: ${JSON.stringify(userRow || null)}`);
        if (userRow) {
          currentUser = { id: userRow.id, username: userRow.username };
          currentSessionId = sessionRow.id;
          securityDb.prepare('UPDATE security_sessions SET last_active = ? WHERE id = ?')
            .run(new Date().toISOString(), sessionCookie);
        }
      }
    } catch (e) {
      debugLog(`Session resolve error: ${e.message}`);
      console.error('[Security] Session resolve error:', e.message);
    }
  } else {
    debugLog(`No wz_session cookie found in request`);
  }

  // Serve static files from ./public
  if (!pathname.startsWith('/api/')) {
    let filePath = pathname === '/' ? '/dashboard.html' : pathname;
    if (filePath === '/docs' || filePath === '/api-docs') {
      filePath = '/docs.html';
    }

    // Intercept protected paths
    if (filePath === '/index.html' || filePath === '/dashboard.html' || filePath === '/docs.html') {
      if (!currentUser) {
        filePath = '/login.html';
      } else if (filePath === '/index.html') {
        filePath = '/dashboard.html';
      }
    }

    const fullPath = path.join(process.cwd(), 'public', filePath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      const mime = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': 'no-store, max-age=0' });
      res.end(fs.readFileSync(fullPath));
      return;
    }
  }

  // Helper: Read and parse JSON request body
  const readBody = (req) => {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          resolve({}); // Fallback if parse fails
        }
      });
      req.on('error', err => reject(err));
    });
  };

  // --- SECURITY ENDPOINTS ---

  // GET /error_boot.log
  if (req.method === 'GET' && pathname === '/error_boot.log') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    try {
      res.end(fs.readFileSync(join(process.cwd(), 'error_boot.log')));
    } catch (_) {
      res.end('No boot error log found.');
    }
    return;
  }

  // GET /api/debug/sessions
  if (req.method === 'GET' && pathname === '/api/debug/sessions') {
    try {
      const users = securityDb.prepare('SELECT id, username FROM security_users').all();
      const sessions = securityDb.prepare('SELECT id, user_id, ip, last_active, expires_at, revoked FROM security_sessions').all();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, users, sessions }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // GET /api/debug/logs
  if (req.method === 'GET' && pathname === '/api/debug/logs') {
    try {
      const logs = fs.readFileSync(join(process.cwd(), 'request_debug.log'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(logs);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Failed to read logs: ${e.message}`);
    }
    return;
  }

  // GET /api/auth/status
  if (req.method === 'GET' && pathname === '/api/auth/status') {
    try {
      const adminExists = securityDb.prepare('SELECT COUNT(*) as count FROM security_users').get().count > 0;
      const hasPasskeysRegistered = adminExists ? (securityDb.prepare('SELECT COUNT(*) as count FROM security_credentials').get().count > 0) : false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, adminExists, hasPasskeysRegistered }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/auth/setup
  if (req.method === 'POST' && pathname === '/api/auth/setup') {
    try {
      const adminExists = securityDb ? (securityDb.prepare('SELECT COUNT(*) as count FROM security_users').get()?.count > 0) : false;
      if (adminExists) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Administrator already configured.' }));
        return;
      }

      const body = await readBody(req);
      const { username, password } = body;
      if (!username || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Username and password are required' }));
        return;
      }

      const userId = crypto.randomUUID();
      const { salt, hash } = hashPassword(password);

      securityDb.prepare('INSERT INTO security_users (id, username, password_hash, password_salt, totp_secret) VALUES (?, ?, ?, ?, ?)')
        .run(userId, username, hash, salt, '');

      createAndSetSession(res, req, userId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/auth/setup-totp-verify
  if (req.method === 'POST' && pathname === '/api/auth/setup-totp-verify') {
    try {
      const authHeader = req.headers['authorization'] || '';
      const tempToken = authHeader.replace('Bearer ', '').trim();
      const setupState = activeChallenges.get(tempToken);

      if (!setupState || setupState.step !== 'totp') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid setup session.' }));
        return;
      }

      const body = await readBody(req);
      const { token } = body;
      const isValid = verifyTOTP(setupState.totpSecret, token);

      if (!isValid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid authentication code. Please try again.' }));
        return;
      }

      // Save user to DB
      securityDb.prepare('INSERT INTO security_users (id, username, password_hash, password_salt, totp_secret) VALUES (?, ?, ?, ?, ?)')
        .run(setupState.userId, setupState.username, setupState.passwordHash, setupState.passwordSalt, setupState.totpSecret);

      setupState.step = 'webauthn'; // Set to webauthn enrollment phase

      // Generate dashboard session immediately
      const sessionToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      securityDb.prepare('INSERT INTO security_sessions (id, user_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(sessionToken, setupState.userId, req.socket.remoteAddress, req.headers['user-agent'], expiresAt.toISOString());

      res.setHeader('Set-Cookie', `wz_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}; Secure`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/auth/webauthn/register-options
  if (req.method === 'POST' && pathname === '/api/auth/webauthn/register-options') {
    try {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace('Bearer ', '').trim();
      
      let userId = null;
      let username = null;
      
      const setupState = activeChallenges.get(token);
      if (setupState) {
        userId = setupState.userId;
        username = setupState.username;
      } else if (currentUser) {
        userId = currentUser.id;
        username = currentUser.username;
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Access denied.' }));
        return;
      }

      const config = getWebAuthnConfig(req);
      const existingCredentials = securityDb.prepare('SELECT id FROM security_credentials WHERE user_id = ?').all(userId);

      const options = await generateRegistrationOptions({
        rpName: config.rpName,
        rpID: config.rpID,
        userID: Buffer.from(String(userId || '')),
        userName: username,
        userDisplayName: username,
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'preferred',
        },
        excludeCredentials: existingCredentials.map(cred => ({
          id: cred.id,
          type: 'public-key',
        })),
      });

      const key = token || currentSessionId;
      activeChallenges.set(`${key}_challenge`, options.challenge);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, options }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/auth/webauthn/register-verify
  if (req.method === 'POST' && pathname === '/api/auth/webauthn/register-verify') {
    try {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace('Bearer ', '').trim();
      const key = token || currentSessionId;

      let userId = null;
      const setupState = activeChallenges.get(token);
      if (setupState) {
        userId = setupState.userId;
      } else if (currentUser) {
        userId = currentUser.id;
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Access denied.' }));
        return;
      }

      const expectedChallenge = activeChallenges.get(`${key}_challenge`);
      if (!expectedChallenge) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Challenge session has expired.' }));
        return;
      }

      const body = await readBody(req);
      const config = getWebAuthnConfig(req);
      
      const verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpID,
        requireUserVerification: false,
      });

      if (verification.verified && verification.registrationInfo) {
        const regInfo = verification.registrationInfo;
        const credInfo = regInfo.credential || regInfo;
        const credentialID = credInfo.id || regInfo.credentialID || body.id;
        const credentialPublicKey = credInfo.publicKey || regInfo.credentialPublicKey;
        const counter = credInfo.counter !== undefined ? credInfo.counter : (regInfo.counter || 0);
        const transports = credInfo.transports || body.response.transports || [];

        if (!credentialPublicKey) {
          throw new Error('Registration Info missing public key.');
        }

        securityDb.prepare(`
          INSERT INTO security_credentials (id, user_id, public_key, sign_counter, transports) 
          VALUES (?, ?, ?, ?, ?)
        `).run(
          credentialID,
          userId,
          Buffer.from(credentialPublicKey).toString('base64'),
          counter,
          JSON.stringify(transports)
        );

        activeChallenges.delete(`${key}_challenge`);
        if (setupState) activeChallenges.delete(token);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Passkey verification failed.' }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/auth/login
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    try {
      const ip = req.socket?.remoteAddress || '127.0.0.1';
      if (!checkRateLimit(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Too many authentication attempts. Please wait 15 minutes.' }));
        return;
      }

      const body = await readBody(req);
      const { username, password } = body;
      if (!username || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Username and password are required' }));
        return;
      }

      const user = securityDb.prepare('SELECT id, username, password_hash, password_salt FROM security_users WHERE username = ?').get(username);
      if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
        incrementRateLimit(ip);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid username or password' }));
        return;
      }

      resetRateLimit(ip);
      createAndSetSession(res, req, user.id);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/auth/totp-verify
  if (req.method === 'POST' && pathname === '/api/auth/totp-verify') {
    try {
      const authHeader = req.headers['authorization'] || '';
      const partialToken = authHeader.replace('Bearer ', '').trim();
      const loginState = activeChallenges.get(partialToken);

      if (!loginState || loginState.step !== 'totp') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid login session.' }));
        return;
      }

      const body = await readBody(req);
      const { token } = body;
      const isValid = verifyTOTP(loginState.totpSecret, token);

      if (!isValid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid 2FA code.' }));
        return;
      }

      const sessionToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      securityDb.prepare('INSERT INTO security_sessions (id, user_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(sessionToken, loginState.userId, req.socket.remoteAddress, req.headers['user-agent'], expiresAt.toISOString());

      activeChallenges.delete(partialToken);

      res.setHeader('Set-Cookie', `wz_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}; Secure`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/auth/webauthn/login-options
  if (req.method === 'POST' && pathname === '/api/auth/webauthn/login-options') {
    try {
      const adminUser = securityDb.prepare('SELECT id, username FROM security_users LIMIT 1').get();
      if (!adminUser) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Setup must be completed first.' }));
        return;
      }

      const config = getWebAuthnConfig(req);
      const credentials = securityDb.prepare('SELECT id, transports FROM security_credentials WHERE user_id = ?').all(adminUser.id);

      const options = await generateAuthenticationOptions({
        rpID: config.rpID,
        allowCredentials: credentials.map(cred => ({
          id: cred.id,
          type: 'public-key',
          transports: JSON.parse(cred.transports || '[]'),
        })),
        userVerification: 'preferred',
      });

      const tempLoginId = crypto.randomBytes(32).toString('hex');
      activeChallenges.set(`${tempLoginId}_challenge`, options.challenge);
      activeChallenges.set(`${tempLoginId}_userId`, adminUser.id);

      res.setHeader('Set-Cookie', `wz_login_challenge=${tempLoginId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=300`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, options }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/auth/webauthn/login-verify
  if (req.method === 'POST' && pathname === '/api/auth/webauthn/login-verify') {
    try {
      const cookies = parseCookies(req);
      const tempLoginId = cookies['wz_login_challenge'];

      if (!tempLoginId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Challenge session expired.' }));
        return;
      }

      const expectedChallenge = activeChallenges.get(`${tempLoginId}_challenge`);
      const userId = activeChallenges.get(`${tempLoginId}_userId`);

      if (!expectedChallenge || !userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Challenge session not found.' }));
        return;
      }

      const body = await readBody(req);
      const cred = securityDb.prepare('SELECT id, public_key, sign_counter FROM security_credentials WHERE id = ? AND user_id = ?').get(body.id, userId);
      if (!cred) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Local key not registered' }));
        return;
      }

      const config = getWebAuthnConfig(req);

      const verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpID,
        authenticator: {
          credentialID: cred.id,
          credentialPublicKey: Buffer.from(cred.public_key || '', 'base64'),
          counter: cred.sign_counter,
        },
        requireUserVerification: false,
      });

      if (verification.verified && verification.authenticationInfo) {
        const newCounter = verification.authenticationInfo?.newCounter ?? (cred.sign_counter + 1);
        securityDb.prepare('UPDATE security_credentials SET sign_counter = ? WHERE id = ?')
          .run(newCounter, cred.id);

        activeChallenges.delete(`${tempLoginId}_challenge`);
        activeChallenges.delete(`${tempLoginId}_userId`);

        const sessionToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        securityDb.prepare('INSERT INTO security_sessions (id, user_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)')
          .run(sessionToken, userId, req.socket.remoteAddress, req.headers['user-agent'], expiresAt.toISOString());

        res.setHeader('Set-Cookie', [
          `wz_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}; Secure`,
          `wz_login_challenge=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
        ]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Verification failed' }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/auth/logout
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    try {
      if (currentSessionId) {
        securityDb.prepare('UPDATE security_sessions SET revoked = 1 WHERE id = ?').run(currentSessionId);
      }
      res.setHeader('Set-Cookie', 'wz_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // GET /api/auth/sessions
  if (req.method === 'GET' && pathname === '/api/auth/sessions') {
    try {
      if (!currentUser) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
        return;
      }

      const sessions = securityDb.prepare(`
        SELECT id, ip, user_agent, last_active 
        FROM security_sessions 
        WHERE user_id = ? AND revoked = 0 AND expires_at > ?
        ORDER BY last_active DESC
      `).all(currentUser.id, new Date().toISOString());

      const userAgentParser = (ua) => {
        let browser = 'Unknown Browser';
        let os = 'Unknown OS';
        if (!ua) return { browser, os };
        
        if (ua.includes('Chrome')) browser = 'Chrome';
        else if (ua.includes('Safari')) browser = 'Safari';
        else if (ua.includes('Firefox')) browser = 'Firefox';
        else if (ua.includes('Edge')) browser = 'Edge';

        if (ua.includes('Windows')) os = 'Windows';
        else if (ua.includes('Macintosh') || ua.includes('Mac OS')) os = 'macOS';
        else if (ua.includes('Linux')) os = 'Linux';
        else if (ua.includes('Android')) os = 'Android';
        else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';

        return { browser, os };
      };

      const result = sessions.map(s => {
        const parsed = userAgentParser(s.user_agent);
        return {
          id: s.id,
          ip: s.ip === '::1' || s.ip === '127.0.0.1' ? 'Localhost' : s.ip,
          browser: parsed.browser,
          os: parsed.os,
          lastActive: new Date(s.last_active).toLocaleString(),
          isCurrent: s.id === currentSessionId
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, sessions: result }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/auth/sessions/revoke
  if (req.method === 'POST' && pathname === '/api/auth/sessions/revoke') {
    try {
      if (!currentUser) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
        return;
      }

      const body = await readBody(req);
      const { sessionId } = body;

      if (!sessionId || sessionId === currentSessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Cannot revoke current session' }));
        return;
      }

      securityDb.prepare('UPDATE security_sessions SET revoked = 1 WHERE id = ? AND user_id = ?')
        .run(sessionId, currentUser.id);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // GET /api/qr/:sessionId — returns current QR state without initiating new connections
  if (req.method === 'GET' && pathname.startsWith('/api/qr/')) {
    const sessionId = pathname.split('/').pop();
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Session ID is required' }));
      return;
    }
    if (!isAuthorized(req, parsedUrl, sessionId, currentUser)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid API Key or Token' }));
      return;
    }
    try {
      const client = clients.get(sessionId);
      if (!client) {
        // Session exists on disk but not initialized yet
        // Check filesystem for creds to determine auth state
        const authed = isSessionRegisteredInDb(sessionId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, qr: null, qrDataUrl: null, connected: authed, pairingCode: null }));
        return;
      }
      let qrDataUrl = null;
      if (client.qrCode) {
        try {
          qrDataUrl = await qrcode.toDataURL(client.qrCode, { width: 300, margin: 1 });
        } catch (qrErr) {
          console.error('[Server] QR generation error:', qrErr.message);
        }
      }
      const reallyConnected = isClientAuthenticated(client, sessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        qr: client.qrCode || null,
        qrDataUrl: qrDataUrl,
        connected: reallyConnected,
        pairingCode: client.pairingCode,
      }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  // GET /api/check-status/:sessionId
  if (req.method === 'GET' && pathname.startsWith('/api/check-status/')) {
    const sessionId = pathname.split('/').pop();
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Session ID is required' }));
      return;
    }
    if (!isAuthorized(req, parsedUrl, sessionId, currentUser)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid API Key or Token' }));
      return;
    }
    
    try {
      const client = await getOrCreateClient(sessionId);
      const reallyConnected = isClientAuthenticated(client, sessionId);
      const keys = getSessionKeys(sessionId);
      let info = {
        success: true,
        sessionId,
        connected: reallyConnected,
        status: reallyConnected ? 'connected' : (client.qrCode ? 'qr' : 'disconnected'),
        message: reallyConnected ? 'connected' : (client.qrCode ? 'qr_ready' : 'disconnected'),
        qrAvailable: !reallyConnected && !!client.qrCode,
        pairingCode: client.pairingCode,
        apiKey: keys.apiKey,
        apiToken: keys.apiToken,
      };
      // Add connection details when authenticated
      const creds = client.socket?.sock?.authState?.creds;
      if (creds) {
        info.phoneNumber = creds.me?.id?.split('@')[0] || null;
        info.jid = creds.me?.id || null;
        info.pushName = creds.pushName || null;
        info.platform = creds.platform || null;
        info.registered = creds.registered || false;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
    } catch (error) {
      console.error('[Server] Status check error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  // GET /api/devices/:sessionId
  if (req.method === 'GET' && pathname.startsWith('/api/devices/')) {
    const sessionId = pathname.split('/').pop();
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Session ID is required' }));
      return;
    }
    if (!isAuthorized(req, parsedUrl, sessionId, currentUser)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid API Key or Token' }));
      return;
    }
    try {
      const client = await getOrCreateClient(sessionId);
      if (!client.connected || !client.socket?.sock) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'WhatsApp session is not connected' }));
        return;
      }
      const rawSock = client.socket.sock;
      const creds = rawSock.authState.creds;
      const queryJid = req.url.includes('target=')
        ? decodeURIComponent(req.url.split('target=')[1].split('&')[0])
        : null;
      const myJid = creds.me?.id;
      if (!myJid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'No user JID found in session' }));
        return;
      }
      const targetJids = queryJid ? [queryJid] : [myJid.split(':')[0] + '@s.whatsapp.net'];
      let devices = [];
      let queryResults = [];
      try {
        const iqNode = {
          tag: 'iq',
          attrs: {
            to: 's.whatsapp.net',
            type: 'get',
            xmlns: 'usync',
          },
          content: [{
            tag: 'usync',
            attrs: {
              context: 'message',
              mode: 'query',
              sid: `devices_${Date.now()}`,
              last: 'true',
              index: '0',
            },
            content: [{
              tag: 'query',
              content: [
                { tag: 'devices', attrs: { version: '2' } },
                { tag: 'lid' },
              ],
            }, {
              tag: 'list',
              content: targetJids.map(j => ({
                tag: 'user',
                attrs: { jid: j.includes('@') ? j : j + '@s.whatsapp.net' },
              })),
            }],
          }],
        };
        const result = await rawSock.query(iqNode);
        if (result?.content) {
          const usyncNode = result.content.find(n => n.tag === 'usync');
          if (usyncNode?.content) {
            const listNode = usyncNode.content.find(n => n.tag === 'list');
            if (listNode?.content) {
              for (const userNode of listNode.content) {
                if (userNode.tag === 'user' && userNode.content) {
                  const userJid = userNode.attrs.jid;
                  const devicesNode = userNode.content.find(n => n.tag === 'devices');
                  const userDevices = [];
                  if (devicesNode?.content) {
                    const deviceListNode = devicesNode.content.find(n => n.tag === 'device-list');
                    if (deviceListNode?.content) {
                      const parsedDevices = deviceListNode.content
                        .filter(n => n.tag === 'device')
                        .map(n => ({
                          id: parseInt(n.attrs.id),
                          keyIndex: n.attrs['key-index'] ? parseInt(n.attrs['key-index']) : null,
                          isHosted: n.attrs['is_hosted'] === 'true',
                        }));
                      userDevices.push(...parsedDevices);
                    }
                  }
                  queryResults.push({ jid: userJid, devices: userDevices });
                  if (userJid === targetJids[0]) {
                    devices = userDevices;
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        console.error('[Server] Device query error:', e.message);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        sessionId,
        userJid: myJid,
        queriedJids: targetJids,
        queryResults,
        devices,
        totalDevices: devices.length,
      }));
    } catch (error) {
      console.error('[Server] Devices query error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  // GET /api/groups/:sessionId
  if (req.method === 'GET' && pathname.startsWith('/api/groups/')) {
    const sessionId = pathname.split('/').pop();
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Session ID is required' }));
      return;
    }
    if (!isAuthorized(req, parsedUrl, sessionId, currentUser)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid API Key or Token' }));
      return;
    }
    try {
      const client = await getOrCreateClient(sessionId);
      if (!client.connected || !client.socket?.sock) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'WhatsApp session is not connected' }));
        return;
      }
      const groups = await client.fetchGroups();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        sessionId,
        total: groups.length,
        groups: groups.map(g => ({
          id: g.id,
          jid: g.id,
          name: g.name || g.subject || 'Unnamed Group',
          size: g.size || g.participants?.length || 0,
          owner: g.owner,
        })),
      }));
    } catch (error) {
      console.error('[Server] Groups fetch error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  // GET /api or /api/ — status checkpoint
  if (req.method === 'GET' && (pathname === '/api' || pathname === '/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: "WazoneIndia API Server is running",
      version: "1.0.0",
      docs: `${parsedUrl.origin}/docs`
    }));
    return;
  }

  // GET /api/sessions — list all known sessions
  if (req.method === 'GET' && pathname === '/api/sessions') {
    const providedKey = req.headers['x-api-key'] || 
                        parsedUrl?.searchParams?.get('apiKey') || 
                        parsedUrl?.searchParams?.get('token');
    
    if (!currentUser) {
      if (!providedKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized: Missing API Key or Token' }));
        return;
      }
    }

    try {
      const sessionsDir = join(process.cwd(), '.berry-sessions');
      let knownSessions = [];
      if (fs.existsSync(sessionsDir)) {
        knownSessions = fs.readdirSync(sessionsDir).filter(name => {
          try { return fs.statSync(join(sessionsDir, name)).isDirectory(); }
          catch { return false; }
        });
      }
      if (!currentUser && providedKey) {
        const isValid = knownSessions.some(sessionId => {
          const keys = getSessionKeys(sessionId);
          return providedKey === keys.apiKey || providedKey === keys.apiToken;
        });
        if (!isValid) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid API Key or Token' }));
          return;
        }
      }
      const result = knownSessions.map(sessionId => {
        const client = clients.get(sessionId);
        const reallyConnected = isClientAuthenticated(client, sessionId);
        const keys = getSessionKeys(sessionId);
        const info = {
          sessionId,
          connected: reallyConnected,
          status: client ? (reallyConnected ? 'connected' : (client.qrCode ? 'qr' : 'disconnected')) : 'uninitialized',
          qrAvailable: client ? (!reallyConnected && !!client.qrCode) : false,
          pairingCode: client?.pairingCode || null,
          apiKey: keys.apiKey,
          apiToken: keys.apiToken,
        };
        const creds = client?.socket?.sock?.authState?.creds;
        if (creds) {
          info.phoneNumber = creds.me?.id?.split('@')[0] || null;
          info.jid = creds.me?.id || null;
          info.pushName = creds.pushName || null;
          info.platform = creds.platform || null;
        }
        return info;
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, sessions: result, total: result.length }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  // POST /api/disconnect — disconnect a session without deleting credentials
  if (req.method === 'POST' && pathname === '/api/disconnect') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { sessionId } = JSON.parse(body);
        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'sessionId is required' }));
          return;
        }
        if (!isAuthorized(req, parsedUrl, sessionId, currentUser)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid API Key or Token' }));
          return;
        }
        const client = clients.get(sessionId);
        if (!client) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Session not found. Initialize it first.' }));
          return;
        }
        client._manualMode = true;
        await client.disconnect().catch(() => {});
        clients.delete(sessionId);
        console.log(`[Server] Session ${sessionId} disconnected.`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Session disconnected.' }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  // POST /api/reconnect — reconnect a session's WebSocket
  if (req.method === 'POST' && pathname === '/api/reconnect') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { sessionId } = JSON.parse(body);
        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'sessionId is required' }));
          return;
        }
        if (!isAuthorized(req, parsedUrl, sessionId, currentUser)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid API Key or Token' }));
          return;
        }
        const client = clients.get(sessionId);
        if (!client) {
          // Initialize the session first, then reconnect
          const newClient = await getOrCreateClient(sessionId);
          newClient.reconnect().catch(err => {
            console.error(`[Server] Reconnect failed:`, err.message);
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Session initialized. Reconnecting...' }));
          return;
        }
        client._manualMode = false;
        client.reconnect().catch(err => {
          console.error(`[Server] Reconnect failed:`, err.message);
        });
        console.log(`[Server] Reconnecting session: ${sessionId}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Reconnecting...' }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  // POST /api/remove-session — disconnect + delete credential data
  if (req.method === 'POST' && pathname === '/api/remove-session') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { sessionId } = JSON.parse(body);
        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'sessionId is required' }));
          return;
        }
        if (!isAuthorized(req, parsedUrl, sessionId, currentUser)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid API Key or Token' }));
          return;
        }
        const client = clients.get(sessionId);
        if (client) {
          client._manualMode = true;
          await client.logout().catch(() => {});
          clients.delete(sessionId);
        }
        const sessionDir = join(process.cwd(), '.berry-sessions', sessionId);
        await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
        console.log(`[Server] Session ${sessionId} removed.`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Session removed.' }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  // POST /api/connect
  if (req.method === 'POST' && pathname === '/api/connect') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { sessionId, phoneNumber } = JSON.parse(body);
        if (!sessionId || !phoneNumber) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'sessionId and phoneNumber are required' }));
          return;
        }
        if (!isAuthorized(req, parsedUrl, sessionId, currentUser)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid API Key or Token' }));
          return;
        }
        // Clear any existing client and session data for a fresh start
        const existing = clients.get(sessionId);
        if (existing) {
          await existing.disconnect().catch(() => {});
          clients.delete(sessionId);
        }
        const sessionDir = join(process.cwd(), '.berry-sessions', sessionId);
        await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 1000));

        const client = await getOrCreateClient(sessionId);
        client.qrCode = null;
        client.pairingCode = null;
        client._connecting = true;
        client._manualMode = true;
        await client.disconnect().catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 2000));
        client._manualMode = false;
        client._connecting = true;
        client.connectWithPairingCode(phoneNumber).catch(err => {
          console.error(`[Server] Pairing code request failed:`, err.message);
          client._connecting = false;
        });
        for (let i = 0; i < 25; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (client.pairingCode || client.connected) break;
        }
        if (client.connected) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Already connected!', pairingCode: null, phoneNumber }));
        } else if (client.pairingCode) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: `Open WhatsApp → Linked Devices → Link with phone number instead and enter: ${client.pairingCode}`,
            pairingCode: client.pairingCode,
            phoneNumber,
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: 'Pairing code request sent. Check your phone for the notification from WhatsApp.',
            pairingCode: null,
            phoneNumber,
          }));
        }
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  // POST /api/connect-qr
  if (req.method === 'POST' && pathname === '/api/connect-qr') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { sessionId } = JSON.parse(body);
        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'sessionId is required' }));
          return;
        }
        if (!isAuthorized(req, parsedUrl, sessionId, currentUser)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid API Key or Token' }));
          return;
        }

        // Check if already connected
        const existingClient = clients.get(sessionId);
        if (existingClient && isClientAuthenticated(existingClient, sessionId)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            connected: true,
            message: 'Already connected.',
          }));
          return;
        }

        // Clean start: disconnect and delete session data
        if (existingClient) {
          existingClient._manualMode = true;
          await existingClient.disconnect().catch(() => {});
          clients.delete(sessionId);
        }
        const sessionDir = join(process.cwd(), '.berry-sessions', sessionId);
        await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 1000));

        const client = await getOrCreateClient(sessionId);
        client.qrCode = null;
        client.pairingCode = null;
        client._manualMode = true;
        await client.disconnect().catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 2000));
        client._manualMode = false;
        client.connect().catch(err => {
          console.error(`[Server] QR connect failed:`, err.message);
        });
        // Wait for QR to arrive (first QR lives 60s, plenty of time)
        await new Promise(resolve => setTimeout(resolve, 5000));
        // Generate QR image as data URL
        let qrDataUrl = null;
        if (client.qrCode) {
          try {
            qrDataUrl = await qrcode.toDataURL(client.qrCode, { width: 300, margin: 1 });
          } catch (qrErr) {
            console.error('[Server] QR generation error:', qrErr.message);
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          connected: isClientAuthenticated(client, sessionId),
          qr: client.qrCode || null,
          qrDataUrl: qrDataUrl,
          message: client.qrCode ? 'QR code ready' : 'Waiting for QR code...',
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  // POST /api/logout
  if (req.method === 'POST' && pathname === '/api/logout') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { sessionId } = JSON.parse(body);
        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'sessionId is required' }));
          return;
        }
        if (!isAuthorized(req, parsedUrl, sessionId, currentUser)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid API Key or Token' }));
          return;
        }
        const client = await getOrCreateClient(sessionId);
        client.authorized = false;
        await client.logout().catch(() => {});
        clients.delete(sessionId);
        console.log(`[Server] Session ${sessionId} logged out and cleared.`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Session logged out. Re-initialize to get a new QR code.' }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  // POST /api/send
  if (req.method === 'POST' && pathname === '/api/send') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const { sessionId, number, type, message, options } = payload;
        
        if (!sessionId || !number) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'sessionId and number are required' }));
          return;
        }
        if (!isAuthorized(req, parsedUrl, sessionId, currentUser)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid API Key or Token' }));
          return;
        }

        const client = await getOrCreateClient(sessionId);
        
        // Format the destination JID (needs @s.whatsapp.net for individual chats)
        let jid = number.trim();
        if (!jid.includes('@')) {
          jid = `${jid}@s.whatsapp.net`;
        }

        console.log(`[Server] Dispatching message [type=${type}] to: ${jid}`);

        if (!client.connected) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: 'WhatsApp session is not connected. Use the pairing code or QR code method to connect.',
          }));
          return;
        }

        let result;

        if (type === 'text') {
          result = await client.sendText(jid, message);
        } else if (type === 'image') {
          result = await client.sendImage(jid, { url: payload.mediaUrl, caption: message });
        } else if (type === 'document') {
          result = await client.sendMessage(jid, {
            document: { url: payload.mediaUrl },
            caption: payload.message,
            fileName: payload.fileName || 'document',
            mimetype: payload.mimetype || 'application/octet-stream',
          });
        } else if (type === 'button') {
          const mappedButtons = (options.buttons || []).map((b, idx) => {
            const btnId = b.id || `btn_${idx}`;
            const btnText = b.text || '';
            if (b.type === 'cta_url') {
              const url = b.url || '';
              return {
                name: 'cta_url',
                buttonParamsJson: JSON.stringify({
                  display_text: btnText,
                  url: url,
                  merchant_url: url
                })
              };
            }
            if (b.type === 'cta_call') {
              const phoneNumber = b.phoneNumber || b.phone || b.url || '';
              return {
                name: 'cta_call',
                buttonParamsJson: JSON.stringify({
                  display_text: btnText,
                  phone_number: phoneNumber
                })
              };
            }
            return {
              name: 'quick_reply',
              buttonParamsJson: JSON.stringify({
                display_text: btnText,
                id: btnId
              })
            };
          });

          const fullMessage = generateWAMessageFromContent(jid, {
            viewOnceMessage: {
              message: {
                interactiveMessage: {
                  body: { text: options.text || '' },
                  footer: { text: options.footer || '' },
                  header: {
                    title: '',
                    hasMediaAttachment: false
                  },
                  nativeFlowMessage: {
                    buttons: mappedButtons,
                    messageParamsJson: '',
                    messageVersion: 1
                  }
                }
              }
            }
          }, {
            userJid: client.socket.sock.user.id
          });

          await client.socket.sock.relayMessage(jid, fullMessage.message, {
            messageId: fullMessage.key.id,
            additionalNodes: [
              {
                tag: 'biz',
                attrs: {},
                content: [
                  {
                    tag: 'interactive',
                    attrs: {
                      type: 'native_flow',
                      v: '1'
                    },
                    content: [
                      {
                        tag: 'native_flow',
                        attrs: {
                          v: '9',
                          name: 'mixed'
                        }
                      }
                    ]
                  }
                ]
              }
            ]
          });

          result = { id: fullMessage.key.id, key: fullMessage.key };
        } else if (type === 'list') {
          const mappedSections = (options.sections || []).map(sec => ({
            title: sec.title,
            rows: (sec.rows || []).map(r => ({
              id: r.rowId || r.id,
              title: r.title,
              description: r.description
            }))
          }));
          result = await client.sendList(jid, {
            title: options.title,
            text: options.text,
            footer: options.footer,
            buttonText: options.buttonText,
            sections: mappedSections
          });
        } else if (type === 'poll') {
          result = await client.socket.sendMessage(jid, {
            poll: {
              name: options.name || '',
              values: options.values || [],
              selectableCount: 1
            }
          });
        } else if (type === 'carousel') {
          const deckText = `Carousel Deck:\n` + (options.cards || []).map((c, idx) => {
            return `[Card ${idx+1}] ${c.title || ''}\n${c.body || ''}`;
          }).join('\n\n') + (options.footer ? `\n\n${options.footer}` : '');
          result = await client.sendText(jid, deckText);
        } else {
          result = await client.sendText(jid, message || JSON.stringify(payload));
        }

        const messageId = result?.id || result?.key?.id || 'unknown';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Message sent successfully',
          messageId,
        }));
      } catch (error) {
        console.error('[Server] Message send error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  // --- LIVE CHAT & AUTOMATION API ENDPOINTS ---

  // GET /api/chats/stream (SSE Stream)
  if (req.method === 'GET' && pathname === '/api/chats/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('data: {"type":"connected"}\n\n');
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

function getAllChats(targetSessionId) {
  const map = new Map();

  // 1. Fetch from chat_threads
  try {
    const query = targetSessionId 
      ? 'SELECT * FROM chat_threads WHERE session_id = ? ORDER BY last_timestamp DESC'
      : 'SELECT * FROM chat_threads ORDER BY last_timestamp DESC';
    const rows = targetSessionId ? securityDb.prepare(query).all(targetSessionId) : securityDb.prepare(query).all();
    for (const r of rows) {
      map.set(r.jid, {
        id: r.id,
        session_id: r.session_id,
        jid: r.jid,
        name: r.name,
        last_message: r.last_message,
        last_timestamp: r.last_timestamp,
        unread_count: r.unread_count || 0
      });
    }
  } catch (err) {
    console.error('[DB GetAllChats chat_threads error]', err.message);
  }

  // 2. Fetch from chats, contacts, messages in berrysdk.db
  try {
    const contactMap = {};
    const contactsRows = securityDb.prepare('SELECT id, payload FROM contacts').all();
    contactsRows.forEach(c => {
      try {
        const p = JSON.parse(c.payload);
        const contactName = p.name || p.pushName || p.shortName || p.notify;
        if (contactName) {
          contactMap[c.id] = contactName;
          contactMap[c.id.split('@')[0]] = contactName;
        }
      } catch(_) {}
    });

    const pushNameMap = {};
    try {
      const messagesRows = securityDb.prepare('SELECT remote_jid, payload FROM messages').all();
      messagesRows.forEach(m => {
        try {
          const mp = JSON.parse(m.payload);
          if (mp.pushName && mp.pushName !== 'Me') {
            pushNameMap[m.remote_jid] = mp.pushName;
            pushNameMap[m.remote_jid.split('@')[0]] = mp.pushName;
          }
        } catch(_) {}
      });
    } catch(_) {}

    const chatsQuery = targetSessionId
      ? "SELECT * FROM chats WHERE (session_id = ? OR session_id = 'test-session') AND id != 'status@broadcast'"
      : "SELECT * FROM chats WHERE id != 'status@broadcast'";
    const chatsRows = targetSessionId ? securityDb.prepare(chatsQuery).all(targetSessionId) : securityDb.prepare(chatsQuery).all();

    for (const c of chatsRows) {
      try {
        const p = JSON.parse(c.payload);
        const jid = c.id;
        const numOnly = jid.split('@')[0].split('-')[0];

        let name = contactMap[jid] || contactMap[numOnly] || pushNameMap[jid] || pushNameMap[numOnly] || p.name;
        
        if (!name || name === jid || name === numOnly) {
          if (jid.endsWith('@s.whatsapp.net')) {
            name = '+' + numOnly;
          } else if (jid.endsWith('@lid')) {
            name = 'LID Contact (' + numOnly.slice(-6) + ')';
          } else if (jid.endsWith('@g.us')) {
            name = 'Group (' + numOnly.slice(-6) + ')';
          } else {
            name = jid;
          }
        }

        const lastMsgRow = securityDb.prepare('SELECT payload FROM messages WHERE remote_jid = ? ORDER BY rowid DESC LIMIT 1').get(jid);
        let msgText = '';
        let msgTime = p.lastMessageAt || new Date().toISOString();
        if (lastMsgRow) {
          try {
            const mp = JSON.parse(lastMsgRow.payload);
            msgText = mp.text || mp.caption || (mp.type ? `[${mp.type}]` : '');
            if (mp.timestamp) msgTime = mp.timestamp;
          } catch(_) {}
        }

        if (!map.has(jid)) {
          map.set(jid, {
            id: `${targetSessionId || c.session_id}:${jid}`,
            session_id: targetSessionId || c.session_id,
            jid,
            name,
            last_message: msgText,
            last_timestamp: msgTime,
            unread_count: p.unreadCount || 0
          });
        }
      } catch(_) {}
    }
  } catch (err) {
    console.error('[DB GetAllChats chats error]', err.message);
  }

  return Array.from(map.values()).sort((a, b) => new Date(b.last_timestamp) - new Date(a.last_timestamp));
}

function getMessagesForJid(sessionId, jid) {
  const map = new Map();

  // 1. Fetch from incoming_messages
  try {
    const rows = securityDb.prepare('SELECT * FROM incoming_messages WHERE jid = ? ORDER BY timestamp ASC').all(jid);
    for (const r of rows) {
      map.set(r.id, {
        id: r.id,
        session_id: r.session_id,
        jid: r.jid,
        sender_name: r.sender_name,
        message_text: r.message_text,
        message_type: r.message_type,
        from_me: r.from_me,
        timestamp: r.timestamp
      });
    }
  } catch (_) {}

  // 2. Fetch from messages table
  try {
    const rows = securityDb.prepare('SELECT * FROM messages WHERE remote_jid = ?').all(jid);
    for (const r of rows) {
      try {
        const mp = JSON.parse(r.payload);
        if (!map.has(r.id)) {
          const isFromMe = mp.fromMe === true || mp.from === 'Me' || mp.to === jid;
          map.set(r.id, {
            id: r.id,
            session_id: sessionId || r.session_id,
            jid: r.remote_jid,
            sender_name: mp.pushName || (isFromMe ? 'Me' : jid.split('@')[0]),
            message_text: mp.text || mp.caption || (mp.type ? `[${mp.type}]` : ''),
            message_type: mp.type || 'text',
            from_me: isFromMe ? 1 : 0,
            timestamp: mp.timestamp || new Date().toISOString()
          });
        }
      } catch (_) {}
    }
  } catch (_) {}

  return Array.from(map.values()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

  // GET /api/chats
  if (req.method === 'GET' && pathname === '/api/chats') {
    try {
      const sessionId = parsedUrl.searchParams.get('sessionId');
      const chats = getAllChats(sessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, chats }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // GET /api/chats/messages
  if (req.method === 'GET' && pathname === '/api/chats/messages') {
    try {
      const sessionId = parsedUrl.searchParams.get('sessionId');
      const jid = parsedUrl.searchParams.get('jid');
      if (!jid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'jid is required' }));
        return;
      }
      const messages = getMessagesForJid(sessionId, jid);
      
      // Clear unread count for this thread
      if (sessionId) {
        const threadId = `${sessionId}:${jid}`;
        securityDb.prepare('UPDATE chat_threads SET unread_count = 0 WHERE id = ?').run(threadId);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, messages }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/chats/send
  if (req.method === 'POST' && pathname === '/api/chats/send') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { sessionId, jid, message } = JSON.parse(body);
        if (!sessionId || !jid || !message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'sessionId, jid, and message are required' }));
          return;
        }

        const formattedJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
        let msgId = `sent_${Date.now()}`;
        const timestamp = new Date().toISOString();

        const client = clients.get(sessionId);
        if (client && (client.connected || client.authorized)) {
          try {
            const sendRes = await client.sendText(formattedJid, message);
            msgId = sendRes?.id || sendRes?.key?.id || msgId;
          } catch (sendErr) {
            console.error('[Live Chat Send Warning]', sendErr.message);
          }
        }

        const record = {
          id: msgId,
          sessionId,
          jid: formattedJid,
          senderName: 'Me',
          text: message,
          type: 'text',
          fromMe: true,
          timestamp
        };

        saveMessageRecord(record);
        broadcastSSE('message', record);
        triggerWebhooks(sessionId, record);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, messageId: msgId, timestamp }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // GET /api/automations/webhooks
  if (req.method === 'GET' && pathname === '/api/automations/webhooks') {
    try {
      const webhooks = securityDb.prepare('SELECT * FROM automation_webhooks ORDER BY created_at DESC').all();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, webhooks }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/automations/webhooks
  if (req.method === 'POST' && pathname === '/api/automations/webhooks') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { action, id, sessionId, url, active } = JSON.parse(body);
        if (action === 'create') {
          if (!url) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'url is required' }));
            return;
          }
          const webhookId = id || `wh_${crypto.randomUUID()}`;
          securityDb.prepare('INSERT INTO automation_webhooks (id, session_id, url, active) VALUES (?, ?, ?, ?)').run(webhookId, sessionId||null, url, active !== undefined ? (active ? 1 : 0) : 1);
        } else if (action === 'delete') {
          securityDb.prepare('DELETE FROM automation_webhooks WHERE id = ?').run(id);
        } else if (action === 'toggle') {
          securityDb.prepare('UPDATE automation_webhooks SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/automations/webhooks/test
  if (req.method === 'POST' && pathname === '/api/automations/webhooks/test') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body);
        if (!url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'url is required' }));
          return;
        }
        const testPayload = {
          event: 'webhook.test',
          timestamp: new Date().toISOString(),
          message: {
            id: 'test_123',
            senderName: 'Test Sender',
            text: 'Hello from WazoneIndia Webhook Test!',
            type: 'text',
            fromMe: false
          }
        };
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(testPayload)
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: response.ok, status: response.status, statusText: response.statusText }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // GET /api/automations/rules
  if (req.method === 'GET' && pathname === '/api/automations/rules') {
    try {
      const rules = securityDb.prepare('SELECT * FROM auto_responders ORDER BY created_at DESC').all();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, rules }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/automations/rules
  if (req.method === 'POST' && pathname === '/api/automations/rules') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { action, id, sessionId, keyword, matchType, replyText, active } = JSON.parse(body);
        if (action === 'create') {
          if (!keyword || !replyText) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'keyword and replyText are required' }));
            return;
          }
          const ruleId = id || `ar_${crypto.randomUUID()}`;
          securityDb.prepare('INSERT INTO auto_responders (id, session_id, keyword, match_type, reply_text, active) VALUES (?, ?, ?, ?, ?, ?)')
            .run(ruleId, sessionId||null, keyword, matchType||'contains', replyText, active !== undefined ? (active ? 1 : 0) : 1);
        } else if (action === 'delete') {
          securityDb.prepare('DELETE FROM auto_responders WHERE id = ?').run(id);
        } else if (action === 'toggle') {
          securityDb.prepare('UPDATE auto_responders SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/automations/rules/test
  if (req.method === 'POST' && pathname === '/api/automations/rules/test') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { keyword, sessionId } = JSON.parse(body);
        const targetSession = sessionId || '919843350000';
        const client = clients.get(targetSession);

        const record = {
          id: `sim_${Date.now()}`,
          sessionId: targetSession,
          jid: '919876543210@s.whatsapp.net',
          senderName: 'Customer Test',
          text: keyword || 'welcome',
          type: 'text',
          fromMe: false,
          timestamp: new Date().toISOString()
        };

        saveMessageRecord(record);
        broadcastSSE('message', record);
        await triggerAutoResponders(targetSession, client, record);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Simulated incoming message for "${keyword}" dispatched!` }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 404 for unknown API endpoints
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, error: 'API endpoint not found' }));
});

// Auto-reconnect registered sessions on startup
async function reconnectRegisteredSessions() {
  try {
    const dbPath = join(process.cwd(), 'berrysdk.db');
    if (!fs.existsSync(dbPath)) return;
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT session_id, payload FROM auth_sessions').all();
    db.close();
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload);
        if (payload.registered === true) {
          console.log(`[Server] Auto-reconnecting session: ${row.session_id}`);
          const client = await getOrCreateClient(row.session_id);
          client.reconnect().catch(err => {
            console.error(`[Server] Auto-reconnect failed for ${row.session_id}:`, err.message);
          });
          // Small delay between reconnections to avoid overwhelming WhatsApp
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (e) {
        console.error(`[Server] Error reconnecting session ${row.session_id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Server] Error scanning for registered sessions:', e.message);
  }
}

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`[Server] WazoneIndia API server listening on http://localhost:${PORT}`);
  // Reconnect previously connected devices after server starts
  setTimeout(reconnectRegisteredSessions, 1000);
});
