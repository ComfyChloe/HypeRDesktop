const { app, BrowserWindow, ipcMain } = require('electron');
if (require('electron-squirrel-startup')) app.quit();

const fs   = require('fs');
const path = require('path');
const WebSocketClient = require('websocket').client;
const mysql = require('mysql2');

// ── Secrets ───────────────────────────────────────────────────────────────────
// secrets.json lives next to the source and is never committed to git.
let secrets = {};
try {
  secrets = JSON.parse(fs.readFileSync(path.join(__dirname, 'secrets.json'), 'utf8'));
} catch (_) { /* absent or invalid — API key falls back to empty string */ }

// ── Configuration ─────────────────────────────────────────────────────────────
const configPath = path.join(path.dirname(process.execPath), 'config.json');

const defaultConfig = {
  sqlEnabled:        false,
  dbHost:            '',
  dbPort:            '3306',
  dbUser:            '',
  dbPassword:        '',
  dbName:            'heartmonitor',
  dbWriteIntervalMs: 2000,  // how often to write the latest heart rate to DB
  staleThresholdMs:  8000,  // readings older than this are skipped on DB write
  trackers:          [],
};

let config = { ...defaultConfig };

function saveConfig(cfg) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error('Failed to write config.json:', err);
  }
}

try {
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    console.log('Created default config.json.');
  }
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!Array.isArray(config.trackers)) config.trackers = [];
  if (typeof config.dbWriteIntervalMs !== 'number' || config.dbWriteIntervalMs < 1)
    config.dbWriteIntervalMs = defaultConfig.dbWriteIntervalMs;
  if (typeof config.staleThresholdMs !== 'number' || config.staleThresholdMs < 1)
    config.staleThresholdMs = defaultConfig.staleThresholdMs;
} catch (err) {
  console.warn('Failed to load config.json; using defaults:', err);
  config = { ...defaultConfig };
}

// ── Database ──────────────────────────────────────────────────────────────────
// Each tracker gets its own CODE_<id> table created on first use.
// startDbTimer() samples the in-memory heart rate at dbWriteIntervalMs and
// writes to the DB only when the reading is still fresh (within staleThresholdMs).

let pool = null;
if (config.sqlEnabled) {
  pool = mysql.createPool({
    host:               config.dbHost,
    port:               parseInt(config.dbPort, 10) || 3306,
    user:               config.dbUser,
    password:           config.dbPassword,
    database:           config.dbName,
    waitForConnections: true,
    connectionLimit:    5,
    queueLimit:         0,
  });
  console.log(`SQL enabled — ${config.dbHost}/${config.dbName}`);
} else {
  console.log('SQL logging disabled.');
}

// Set of tracker IDs whose CODE_* table has been confirmed to exist this session.
const readyTables = new Set();

function createTableForTracker(id) {
  if (!pool) return;
  const safeId = id.replace(/[^a-zA-Z0-9_]/g, '');
  const sql = `
    CREATE TABLE IF NOT EXISTS \`CODE_${safeId}\` (
      id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      recorded_at DATETIME NOT NULL,
      heart_rate  TINYINT UNSIGNED NOT NULL,
      INDEX idx_recorded_at (recorded_at)
    )`;
  pool.execute(sql, [], (err) => {
    if (err) return console.error(`Error creating CODE_${safeId} table:`, err);
    readyTables.add(safeId);
    console.log(`CODE_${safeId} table ready.`);
  });
}

function storeHeartRateNow(trackerId, heartRate) {
  if (!config.sqlEnabled || !pool || heartRate === 0) return;
  const safeId = trackerId.replace(/[^a-zA-Z0-9_]/g, '');
  if (!readyTables.has(safeId)) return;
  pool.execute(
    `INSERT INTO \`CODE_${safeId}\` (recorded_at, heart_rate) VALUES (NOW(), ?)`,
    [heartRate],
    (err) => { if (err) console.error(`DB write error for ${safeId}:`, err); }
  );
}

function initDb() {
  if (!pool) return;
  Object.keys(IDs).forEach(id => createTableForTracker(id));
}

function startDbTimer() {
  setInterval(() => {
    const now = Date.now();
    Object.keys(IDs).forEach((id) => {
      const { lastHeartrate, lastChanged } = IDs[id];
      if (lastHeartrate === 0) return;
      if (now - lastChanged > config.staleThresholdMs) return;
      storeHeartRateNow(id, lastHeartrate);
    });
  }, config.dbWriteIntervalMs || 2000);
}

// ── Tracker state ─────────────────────────────────────────────────────────────
// IDs is the in-memory source of truth. The renderer receives a copy on every change.

const IDs = {};
config.trackers.forEach(({ id, name }) => {
  IDs[id] = { name, lastUpdate: 0, lastHeartrate: 0, lastChanged: 0 };
});

// ── WebSocket setup ───────────────────────────────────────────────────────────
const API_KEY = secrets?.hyperate?.apiKey ?? '';
const API_URL = `wss://app.hyperate.io/socket/websocket?token=${API_KEY}`;
const client  = new WebSocketClient();

let mainWindow        = null;
let connectionSocket  = null;
let heartbeatInterval = null;

// ── Message handling ──────────────────────────────────────────────────────────
function onMessage(data) {
  if (data.event === 'hr_update') onHrUpdate(data);
}

function onHrUpdate(data) {
  const id        = data.topic.split(':')[1];
  const heartRate = data.payload.hr;
  if (!IDs[id]) return;

  // Reset watchdog counters — live data is flowing.
  lastHrUpdateTime    = Date.now();
  watchdogRejoinCount = 0;

  const now = Date.now();
  if (heartRate !== IDs[id].lastHeartrate) {
    IDs[id].lastHeartrate = heartRate;
    IDs[id].lastChanged   = now;
  }
  IDs[id].lastUpdate = now;

  mainWindow?.webContents.send('update-heart-rate', IDs);
}

// ── Channel management ────────────────────────────────────────────────────────
function joinTrackerChannel(id) {
  if (!connectionSocket?.connected) return;
  connectionSocket.sendUTF(JSON.stringify({ topic: `hr:${id}`, event: 'phx_join', payload: {}, ref: 0 }));
  console.log(`Joined channel: ${id}`);
}

function addHeartRateTracker(id, name) {
  if (!IDs[id]) {
    IDs[id] = { name, lastUpdate: 0, lastHeartrate: 0, lastChanged: 0 };
    config.trackers.push({ id, name });
    saveConfig(config);
    createTableForTracker(id);
  }
  console.log(`Tracker added: ${id} (${name})`);
  if (connectionSocket?.connected) joinTrackerChannel(id);
}

function removeHeartRateTracker(id) {
  if (!IDs[id]) return;
  if (connectionSocket?.connected) {
    connectionSocket.sendUTF(JSON.stringify({ topic: `hr:${id}`, event: 'phx_leave', payload: {}, ref: 0 }));
  }
  delete IDs[id];
  config.trackers = config.trackers.filter(t => t.id !== id);
  saveConfig(config);
  mainWindow?.webContents.send('update-heart-rate', { ...IDs });
  console.log(`Tracker removed: ${id}`);
}

// ── Reconnection ──────────────────────────────────────────────────────────────
let reconnectScheduled = false;

function scheduleReconnect(reason) {
  if (reconnectScheduled) return;
  reconnectScheduled = true;
  console.log(`Reconnect in 10 s (${reason})`);
  setTimeout(() => {
    reconnectScheduled = false;
    console.log('Reconnecting...');
    client.connect(API_URL);
  }, 10_000);
}

// ── Channel watchdog ──────────────────────────────────────────────────────────
// HypeRate silently drops hr: subscriptions without closing the WebSocket.
// Every 60 s we check whether any hr_update has arrived in the last 3 minutes.
// If not, we re-join all channels. After two failed rejoins we force a full
// WS reconnect so the connection is reset from scratch.

const CHANNEL_STALE_MS  = 3 * 60 * 1000;
let lastHrUpdateTime    = 0;
let watchdogRejoinCount = 0;

function rejoinAllChannels() {
  Object.keys(IDs).forEach(id => joinTrackerChannel(id));
}

function startChannelWatchdog() {
  // First check at 30 s catches immediate join failures on startup.
  // Subsequent checks run every 60 s.
  setTimeout(function doCheck() {
    const count = Object.keys(IDs).length;
    if (count === 0) { setTimeout(doCheck, 60_000); return; }

    if (!connectionSocket?.connected) {
      console.log('Watchdog: not connected — scheduling reconnect');
      watchdogRejoinCount = 0;
      scheduleReconnect('watchdog');
    } else {
      const elapsed = Date.now() - lastHrUpdateTime;
      const stale   = lastHrUpdateTime === 0 || elapsed > CHANNEL_STALE_MS;
      if (stale) {
        watchdogRejoinCount++;
        const since = lastHrUpdateTime === 0 ? 'never' : `${Math.round(elapsed / 1000)}s ago`;
        if (watchdogRejoinCount >= 2) {
          console.log(`Watchdog: ${watchdogRejoinCount} rejoins with no data — forcing full reconnect`);
          watchdogRejoinCount = 0;
          connectionSocket.close();
        } else {
          console.log(`Watchdog: last update ${since} — re-joining ${count} channel(s) (attempt ${watchdogRejoinCount})`);
          rejoinAllChannels();
        }
      } else {
        watchdogRejoinCount = 0; // live data is flowing, all good
      }
    }
    setTimeout(doCheck, 60_000);
  }, 30_000);
}

// ── Electron window ───────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:           100,
    height:          100,
    frame:           false,
    resizable:       false,
    autoHideMenuBar: true,
    transparent:     true,
    alwaysOnTop:     true,
    hasShadow:       false,
    webPreferences:  { preload: path.join(__dirname, 'preload.js') },
  });

  ipcMain.on('close-app',      ()                => mainWindow.close());
  ipcMain.on('add-tracker',    (_, { ID, name }) => addHeartRateTracker(ID, name));
  ipcMain.on('remove-tracker', (_, { ID })       => removeHeartRateTracker(ID));

  mainWindow.loadFile('index.html');

  // Push initial tracker state to the renderer so all configured widgets
  // appear immediately, without waiting for the first WebSocket update.
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('update-heart-rate', IDs);
  });

  console.log('Connecting to HypeRate...');
  client.connect(API_URL);
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  initDb();
  startDbTimer();
  startChannelWatchdog();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  connectionSocket?.close();
  if (heartbeatInterval) clearInterval(heartbeatInterval);
});

// ── WebSocket event handlers ──────────────────────────────────────────────────
client.on('connectFailed', (error) => {
  console.error('WS connect failed:', error.toString());
  scheduleReconnect('connectFailed');
});

client.on('connect', (connection) => {
  connectionSocket = connection;
  console.log('WS connected');

  // Phoenix heartbeat keeps the HypeRate connection alive.
  heartbeatInterval = setInterval(() => {
    if (connection.connected) {
      connection.sendUTF(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: 0 }));
    }
  }, 30_000);

  connection.on('close', () => {
    console.log('WS connection closed');
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    scheduleReconnect('connection closed');
  });

  connection.on('message', (message) => {
    if (message.type !== 'utf8') return;
    try { onMessage(JSON.parse(message.utf8Data)); }
    catch (err) { console.error('WS parse error:', err); }
  });

  // Subscribe to every configured tracker's channel.
  Object.keys(IDs).forEach(id => joinTrackerChannel(id));
});
