import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { rm } from 'fs/promises';
import { join } from 'path';
import BerryProtocol from './dist/index.js';
import pino from 'pino';
import qrcode from 'qrcode';
import Database from 'better-sqlite3';

const logger = pino({ level: 'info' });
const clients = new Map();

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
    // Only intervene for authorized sessions — the socket handles QR-mode reconnections internally
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
  // Debug logging removed after testing

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

  // Periodic auth state monitor — checks socket creds every 5s
  // Handles cases where baileys auth events may not fire properly
  if (!client._authMonitor) {
    client._authMonitor = setInterval(() => {
      if (client.authorized || client.connected) {
        // Already marked as connected, no need to monitor
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

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // Serve static files from ./public
  if (!pathname.startsWith('/api/')) {
    const filePath = pathname === '/' ? '/index.html' : pathname;
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

  // GET /api/qr/:sessionId — returns current QR state without initiating new connections
  if (req.method === 'GET' && pathname.startsWith('/api/qr/')) {
    const sessionId = pathname.split('/').pop();
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Session ID is required' }));
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
    
    try {
      const client = await getOrCreateClient(sessionId);
      const reallyConnected = isClientAuthenticated(client, sessionId);
      let info = {
        success: true,
        sessionId,
        connected: reallyConnected,
        status: reallyConnected ? 'connected' : (client.qrCode ? 'qr' : 'disconnected'),
        message: reallyConnected ? 'connected' : (client.qrCode ? 'qr_ready' : 'disconnected'),
        qrAvailable: !reallyConnected && !!client.qrCode,
        pairingCode: client.pairingCode,
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

  // GET /api/sessions — list all known sessions
  if (req.method === 'GET' && pathname === '/api/sessions') {
    try {
      const sessionsDir = join(process.cwd(), '.berry-sessions');
      let knownSessions = [];
      if (fs.existsSync(sessionsDir)) {
        knownSessions = fs.readdirSync(sessionsDir).filter(name => {
          try { return fs.statSync(join(sessionsDir, name)).isDirectory(); }
          catch { return false; }
        });
      }
      const result = knownSessions.map(sessionId => {
        const client = clients.get(sessionId);
        const reallyConnected = isClientAuthenticated(client, sessionId);
        const info = {
          sessionId,
          connected: reallyConnected,
          status: client ? (reallyConnected ? 'connected' : (client.qrCode ? 'qr' : 'disconnected')) : 'uninitialized',
          qrAvailable: client ? (!reallyConnected && !!client.qrCode) : false,
          pairingCode: client?.pairingCode || null,
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
            const btn = {
              id: b.id || `btn_${idx}`,
              title: b.text,
            };
            if (b.type === 'quick_reply') {
              btn.kind = 'quick_reply';
            } else if (b.type === 'cta_url') {
              btn.kind = 'cta_url';
              btn.url = b.url;
            } else {
              btn.kind = 'quick_reply';
            }
            return btn;
          });
          result = await client.sendButtons(jid, {
            text: options.text,
            footer: options.footer,
            buttons: mappedButtons
          });
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
          const pollText = `Poll: ${options.name || ''}\n\n` + (options.values || []).map((v, i) => `${i + 1}. ${v}`).join('\n');
          result = await client.sendText(jid, pollText);
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

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, error: 'Not Found' }));
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
