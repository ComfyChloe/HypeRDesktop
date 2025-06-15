const { app, BrowserWindow, ipcMain } = require('electron');
if (require('electron-squirrel-startup')) app.quit();

const fs = require('fs');
const path = require('path');
const WebSocketClient = require('websocket').client;
const JSONlib = require('JSON');
const mysql = require('mysql2');

const defaultConfig = {
  sqlEnabled: false,
  dbHost: "",
  dbPort: "3306",
  dbUser: "",
  dbPassword: "",
  dbName: "heartmonitor",
  dbWriteIntervalMs: 2000,  // 2s
  staleThresholdMs: 8000,   // 8s
  trackers: []
};

const configPath = path.join(path.dirname(process.execPath), 'config.json');

let config = { ...defaultConfig };
function saveConfig(cfg) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    console.log("Config saved successfully.");
  } catch (err) {
    console.error('Failed to write config.json:', err);
  }
}
try {
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    console.log("Created default config.json (SQL disabled by default).");
  }
  const rawConfig = fs.readFileSync(configPath, 'utf8');
  config = JSONlib.parse(rawConfig);

  if (!Array.isArray(config.trackers)) {
    config.trackers = [];
  }
  if (
    typeof config.dbWriteIntervalMs !== 'number' ||
    isNaN(config.dbWriteIntervalMs) ||
    config.dbWriteIntervalMs < 1
  ) {
    config.dbWriteIntervalMs = defaultConfig.dbWriteIntervalMs;
  }
  if (
    typeof config.staleThresholdMs !== 'number' ||
    isNaN(config.staleThresholdMs) ||
    config.staleThresholdMs < 1
  ) {
    config.staleThresholdMs = defaultConfig.staleThresholdMs;
  }
} catch (err) {
  console.warn('Failed to load config.json; using defaults:', err);
  config = { ...defaultConfig };
}

let pool = null;
if (config.sqlEnabled) {
  pool = mysql.createPool({
    host: config.dbHost,
    port: config.dbPort,
    user: config.dbUser,
    password: config.dbPassword,
    database: config.dbName
  });
  console.log("SQL Enabled. Connecting to DB:", config.dbHost, config.dbName);
} else {
  console.log("SQL logging disabled (sqlEnabled=false).");
}

function createTableForTracker(tracker_id, callback) {
  if (!pool) return;
  const safeTableName = `CODE_${tracker_id.replace(/[^a-zA-Z0-9_]/g, '')}`;
  const createQuery = `
    CREATE TABLE IF NOT EXISTS \`${safeTableName}\` (
      time_text VARCHAR(20) NOT NULL,
      heart_rate TINYINT UNSIGNED NOT NULL
    );
  `;
  pool.execute(createQuery, [], (err) => {
    if (err) {
      console.error(`Error creating table ${safeTableName}:`, err);
      return;
    }
    if (typeof callback === 'function') callback(safeTableName);
  });
}
function storeHeartRateNow(tracker_id, heartRate, timeText) {
  if (!config.sqlEnabled || !pool) return;
  if (heartRate === 0) return;  

  createTableForTracker(tracker_id, (tableName) => {
    const insertSql = `INSERT INTO \`${tableName}\` (time_text, heart_rate) VALUES (?, ?)`;
    pool.execute(insertSql, [timeText, heartRate], (err) => {
      if (err) {
        console.error('Error storing data:', err);
      }
    });
  });
}
const IDs = {};
config.trackers.forEach(tracker => {
  IDs[tracker.id] = {
    name: tracker.name,
    lastUpdate: 0,
    lastHeartrate: 0,
    lastChanged: 0
  };
});

let lastDay = "";
function buildTimeText() {
  const now = new Date();
  const isoStr = now.toISOString();
  const datePart = isoStr.slice(0, 10);   // YYYY-MM-DD
  const timePart = isoStr.slice(11, 19);  // HH:MM:SS

  if (datePart !== lastDay) {
    lastDay = datePart; 
    return `${datePart} ${timePart}`;
  } else {
    return timePart;
  }
}

function startDbTimer() {
  const ms = config.dbWriteIntervalMs || 2000;
  setInterval(() => {
    const timeText = buildTimeText();
    const now = Date.now();

    Object.keys(IDs).forEach((ID) => {
      const hr = IDs[ID].lastHeartrate;
      if (hr === 0) return;

      const timeSinceChanged = now - IDs[ID].lastChanged;
      if (timeSinceChanged > config.staleThresholdMs) {
        // It's stale => skip
        return;
      }

      storeHeartRateNow(ID, hr, timeText);
    });
  }, ms);
}

let reconnectScheduled = false;
function scheduleReconnect(reason) {
  if (!reconnectScheduled) {
    reconnectScheduled = true;
    console.log(`Scheduling reconnect in 10 seconds due to: ${reason}`);
    setTimeout(() => {
      reconnectScheduled = false;
      console.log("Attempting reconnection now...");
      client.connect(API_URL);
    }, 10000);
  }
}
const API_KEY = "";
const API_URL = `wss://app.hyperate.io/socket/websocket?token=${API_KEY}`;
const client = new WebSocketClient();
let mainWindow = null;
let connectionSocket = null;
let heartbeatInterval = null;

function onMessage(data) {
  if (data.event === "hr_update") {
    onHrUpdate(data);
  }
}

function onHrUpdate(data) {
  const ID = data.topic.split(":")[1];
  const heartRate = data.payload.hr;
  if (!IDs[ID]) return;

  if (heartRate !== IDs[ID].lastHeartrate) {
    IDs[ID].lastChanged = Date.now();
    IDs[ID].lastHeartrate = heartRate;
  }
  IDs[ID].lastUpdate = Date.now();

  if (mainWindow) {
    mainWindow.webContents.send("update-heart-rate", IDs);
  }
}
function joinTrackerChannel(ID) {
  if (connectionSocket && connectionSocket.connected) {
    connectionSocket.sendUTF(JSON.stringify({
      topic: `hr:${ID}`,
      event: "phx_join",
      payload: {},
      ref: 0
    }));
    console.log(`Joined channel for ${ID}`);
  }
}
function addHeartRateTracker(ID, name) {
  if (!IDs[ID]) {
    IDs[ID] = {
      name,
      lastUpdate: 0,
      lastHeartrate: 0,
      lastChanged: 0
    };
    config.trackers.push({ id: ID, name });
    saveConfig(config);
  }
  console.log(`Adding new heart rate tracker: ${ID} (${name})`);

  if (connectionSocket && connectionSocket.connected) {
    joinTrackerChannel(ID);
  }
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 100,
    height: 100,
    frame: false,
    resizable: false,
    autoHideMenuBar: true,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    },
  });

  ipcMain.on("close-app", () => mainWindow.close());
  ipcMain.on("add-tracker", (event, data) => addHeartRateTracker(data.ID, data.name));

  mainWindow.loadFile('index.html');

  console.log("Connecting to HypeRate...");
  client.connect(API_URL);
}
app.whenReady().then(() => {
  createWindow();
  startDbTimer(); // Storing data on a global timer
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (connectionSocket && connectionSocket.connected) {
    connectionSocket.close();
  }
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
});
client.on('connectFailed', function (error) {
  console.log("Connect Failed:", error.toString());
  scheduleReconnect("connectFailed");
});

client.on('connect', function (connection) {
  connectionSocket = connection;
  console.log("Client Connected");
  heartbeatInterval = setInterval(() => {
    if (connection && connection.connected) {
      connection.sendUTF(JSON.stringify({
        topic: "phoenix",
        event: "heartbeat",
        payload: {},
        ref: 0
      }));
    }
  }, 30000);

  connection.on("close", function () {
    console.log("Connection Closed");
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    scheduleReconnect("connection closed");
  });

  connection.on("message", function (message) {
    if (message.type !== "utf8") {
      return console.error("Message is not UTF8");
    }
    try {
      const data = JSONlib.parse(message.utf8Data);
      onMessage(data);
    } catch (err) {
      console.error("Parse error:", err);
    }
  });

  // Join all known trackers
  Object.keys(IDs).forEach((ID) => {
    joinTrackerChannel(ID);
  });
});
