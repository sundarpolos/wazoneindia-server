// Apply critical SDK patches after npm install
// These patches fix credential persistence and QR stability
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const patches = [
  {
    file: 'node_modules/@berrysdk/transport/vendor/lib/Utils/use-multi-file-auth-state.js',
    apply: (content) => {
      const oldStr = 'const creds = (await readData(\'creds.json\')) || initAuthCreds();';
      const newStr = oldStr + ' if (!await readData(\'creds.json\')) { await writeData(creds, \'creds.json\'); }';
      if (content.includes(newStr)) return { patched: false, msg: 'already patched' };
      if (!content.includes(oldStr)) return { patched: false, msg: 'pattern not found' };
      return { patched: true, content: content.replace(oldStr, newStr), msg: 'creds.json write patched' };
    }
  },
  {
    file: 'node_modules/@berrysdk/socket/dist/index.js',
    apply: (content) => {
      const oldStr = 'void saveCreds();';
      const newStr = 'saveCreds().catch(err => console.error("[Socket] saveCreds error:", err));';
      if (content.includes(newStr)) return { patched: false, msg: 'already patched' };
      if (!content.includes(oldStr)) return { patched: false, msg: 'pattern not found' };
      return { patched: true, content: content.replace(oldStr, newStr), msg: 'saveCreds error handling patched' };
    }
  },
  {
    file: 'node_modules/@berrysdk/store/dist/index.js',
    apply: (content) => {
      const oldStr = 'import Database from "better-sqlite3";';
      const newStr = `import fs from 'fs';
import path from 'path';

class Database {
  constructor(filepath = "berrysdk.db") {
    this.filepath = filepath.replace(/\\.db$/, '.json');
    this.data = { auth_sessions: {}, chats: {}, contacts: {}, groups: {}, messages: {}, message_acks: {} };
    this.load();
  }
  load() {
    try {
      if (fs.existsSync(this.filepath)) {
        const content = fs.readFileSync(this.filepath, 'utf8');
        if (content.trim().startsWith('{')) {
          const parsed = JSON.parse(content);
          this.data = {
            auth_sessions: parsed.auth_sessions || {},
            chats: parsed.chats || {},
            contacts: parsed.contacts || {},
            groups: parsed.groups || {},
            messages: parsed.messages || {},
            message_acks: parsed.message_acks || {}
          };
        }
      }
    } catch (_) {}
  }
  save() {
    try {
      fs.writeFileSync(this.filepath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (_) {}
  }
  exec() { this.save(); }
  transaction(fn) {
    return (...args) => {
      const res = fn(...args);
      this.save();
      return res;
    };
  }
  prepare(sql) {
    const db = this;
    if (!db.data) db.data = {};
    db.data.auth_sessions = db.data.auth_sessions || {};
    db.data.chats = db.data.chats || {};
    db.data.contacts = db.data.contacts || {};
    db.data.groups = db.data.groups || {};
    db.data.messages = db.data.messages || {};
    db.data.message_acks = db.data.message_acks || {};
    return {
      run(params) {
        if (sql.includes('auth_sessions')) {
          const sid = typeof params === 'object' && params !== null ? params.session_id || params[0] : params;
          if (sql.includes('DELETE')) {
            delete db.data.auth_sessions[sid];
          } else {
            const payload = typeof params === 'object' && params.payload ? params.payload : JSON.stringify(params);
            db.data.auth_sessions[sid] = { payload, updated_at: new Date().toISOString() };
          }
        } else if (sql.includes('chats')) {
          const id = params?.id; const sid = params?.session_id;
          if (id && sid) db.data.chats[\`\${id}_\${sid}\`] = params;
        } else if (sql.includes('contacts')) {
          const id = params?.id; const sid = params?.session_id;
          if (id && sid) db.data.contacts[\`\${id}_\${sid}\`] = params;
        } else if (sql.includes('groups')) {
          const id = params?.id; const sid = params?.session_id;
          if (id && sid) db.data.groups[\`\${id}_\${sid}\`] = params;
        } else if (sql.includes('messages')) {
          const id = params?.id; const sid = params?.session_id;
          if (id && sid) db.data.messages[\`\${id}_\${sid}\`] = params;
        } else if (sql.includes('message_acks')) {
          const id = params?.message_id; const sid = params?.session_id;
          if (id && sid) db.data.message_acks[\`\${id}_\${sid}\`] = params;
        }
        db.save();
        return { changes: 1 };
      },
      get(sessionId) {
        if (sql.includes('auth_sessions')) {
          const row = db.data.auth_sessions[sessionId];
          return row ? { payload: row.payload } : undefined;
        }
        return undefined;
      }
    };
  }
}`;
      if (content.includes('class Database {')) return { patched: false, msg: 'already patched' };
      if (!content.includes(oldStr)) return { patched: false, msg: 'pattern not found' };
      return { patched: true, content: content.replace(oldStr, newStr), msg: 'better-sqlite3 ESM import patched to pure JS' };
    }
  }
];

let patchedCount = 0;
for (const p of patches) {
  const filePath = join(__dirname, p.file);
  if (!existsSync(filePath)) {
    console.log(`[patch] ${p.file} — not found, skipping`);
    continue;
  }
  const content = readFileSync(filePath, 'utf-8');
  const result = p.apply(content);
  if (result.patched) {
    writeFileSync(filePath, result.content, 'utf-8');
    console.log(`[patch] ${p.file} — ${result.msg}`);
    patchedCount++;
  } else {
    console.log(`[patch] ${p.file} — ${result.msg}`);
  }
}
console.log(`[patch] Done — ${patchedCount} file(s) patched`);
