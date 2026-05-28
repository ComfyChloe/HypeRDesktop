'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3030;

// Look for config.json in ServerGraph/ first, then the project root one level up
const CONFIG_CANDIDATES = [
  path.join(__dirname, 'config.json'),
  path.join(__dirname, '..', 'config.json'),
];

const DEFAULT_CONFIG = {
  sqlEnabled: false,
  dbHost: 'localhost',
  dbPort: '3306',
  dbUser: '',
  dbPassword: '',
  dbName: 'heartmonitor',
};

let configPath = CONFIG_CANDIDATES[0];
let config = { ...DEFAULT_CONFIG };

function loadConfig() {
  for (const candidate of CONFIG_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf8');
        config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
        configPath = candidate;
        console.log(`[config] Loaded from ${candidate}`);
        return;
      } catch (e) {
        console.warn(`[config] Failed to parse ${candidate}:`, e.message);
      }
    }
  }
  console.log('[config] No config.json found. Configure via the web UI.');
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`[config] Saved to ${configPath}`);
  } catch (e) {
    console.error('[config] Save failed:', e.message);
  }
}

// ── Pool ──────────────────────────────────────────────────────────────────────

let pool = null;
const tableCache = new Map();

function initPool() {
  if (pool) pool.end().catch(() => {});
  pool = null;
  tableCache.clear();
  if (!config.dbHost || !config.dbUser) return;
  pool = mysql.createPool({
    host: config.dbHost,
    port: Number(config.dbPort) || 3306,
    user: config.dbUser,
    password: config.dbPassword,
    database: config.dbName,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    connectTimeout: 15000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  });
}

async function testConnection() {
  if (!pool) return { ok: false, error: 'Pool not initialized' };
  try {
    const conn = await pool.getConnection();
    conn.release();
    return { ok: true };
  } catch (e) {
    console.error('[db] Connection failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Table detection ───────────────────────────────────────────────────────────

async function tableExists(name) {
  if (tableCache.has(name)) return tableCache.get(name);
  try {
    const [[row]] = await pool.execute(
      'SELECT COUNT(*) AS cnt FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [name]
    );
    const exists = Number(row.cnt) > 0;
    tableCache.set(name, exists);
    return exists;
  } catch {
    return false;
  }
}

async function detectTrackers() {
  if (!pool) return [];
  const trackers = new Map();
  try {
    const [rows] = await pool.execute(
      "SELECT TABLE_NAME, COALESCE(TABLE_ROWS, 0) AS row_est FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'CODE_%'"
    );
    for (const row of rows) {
      const id = row.TABLE_NAME.replace(/^CODE_/, '');
      trackers.set(id, { id, sources: ['table'], rowEstimate: Number(row.row_est) });
    }
  } catch (e) {
    console.warn('[detect] CODE_* scan error:', e.message);
  }
  try {
    if (await tableExists('heartrate_log')) {
      const [rows] = await pool.execute(
        'SELECT tracker_id, COUNT(*) AS cnt FROM heartrate_log GROUP BY tracker_id'
      );
      for (const row of rows) {
        const id = row.tracker_id;
        if (trackers.has(id)) {
          trackers.get(id).sources.push('log');
        } else {
          trackers.set(id, { id, sources: ['log'], rowEstimate: Number(row.cnt) });
        }
      }
    }
  } catch (e) {
    console.warn('[detect] heartrate_log scan error:', e.message);
  }
  return [...trackers.values()];
}

// ── Validation helpers ────────────────────────────────────────────────────────

function safeId(id) {
  return id.replace(/[^a-zA-Z0-9_]/g, '');
}

function isValidTrackerId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && /^[a-zA-Z0-9_]+$/.test(id);
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function toMySQLDate(d) {
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

// ── Query builder ─────────────────────────────────────────────────────────────

const INTERVAL_SECS = { '1m': 60, '5m': 300, '1h': 3600, '1d': 86400 };
const VALID_INTERVALS = new Set(['raw', '1m', '5m', '1h', '1d']);

async function resolveSource(tracker, from, to) {
  const sid = safeId(tracker);
  const fromStr = toMySQLDate(from);
  const toStr = toMySQLDate(to);
  const perTable = `CODE_${sid}`;
  if (await tableExists(perTable)) {
    return { source: 'table', table: perTable, fromStr, toStr, trackerParam: null };
  }
  if (await tableExists('heartrate_log')) {
    return { source: 'log', table: 'heartrate_log', fromStr, toStr, trackerParam: tracker };
  }
  return null;
}

async function queryHeartrate(tracker, from, to, interval) {
  const src = await resolveSource(tracker, from, to);
  if (!src) return { error: `No data table found for tracker: ${tracker}` };
  const { source, table, fromStr, toStr, trackerParam } = src;
  const isPerTable = source === 'table';
  if (interval === 'raw') {
    let sql, params;
    if (isPerTable) {
      sql = `SELECT UNIX_TIMESTAMP(recorded_at) AS time, heart_rate AS value FROM \`${table}\` WHERE recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at LIMIT 10000`;
      params = [fromStr, toStr];
    } else {
      sql = `SELECT UNIX_TIMESTAMP(recorded_at) AS time, heart_rate AS value FROM \`${table}\` WHERE tracker_id = ? AND recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at LIMIT 10000`;
      params = [trackerParam, fromStr, toStr];
    }
    const [rows] = await pool.execute(sql, params);
    return { mode: 'raw', data: rows.map(r => ({ time: Number(r.time), value: Number(r.value) })) };
  }
  const secs = INTERVAL_SECS[interval];
  const bucket = `FLOOR(UNIX_TIMESTAMP(recorded_at) / ${secs}) * ${secs}`;
  let sql, params;
  if (isPerTable) {
    sql = `SELECT ${bucket} AS time, ROUND(AVG(heart_rate), 1) AS avg_hr, MIN(heart_rate) AS min_hr, MAX(heart_rate) AS max_hr, COUNT(*) AS cnt FROM \`${table}\` WHERE recorded_at >= ? AND recorded_at <= ? GROUP BY time ORDER BY time`;
    params = [fromStr, toStr];
  } else {
    sql = `SELECT ${bucket} AS time, ROUND(AVG(heart_rate), 1) AS avg_hr, MIN(heart_rate) AS min_hr, MAX(heart_rate) AS max_hr, COUNT(*) AS cnt FROM \`${table}\` WHERE tracker_id = ? AND recorded_at >= ? AND recorded_at <= ? GROUP BY time ORDER BY time`;
    params = [trackerParam, fromStr, toStr];
  }
  const [rows] = await pool.execute(sql, params);
  return {
    mode: 'aggregated', interval,
    data: rows.map(r => ({
      time: Number(r.time),
      avg: Number(r.avg_hr),
      min: Number(r.min_hr),
      max: Number(r.max_hr),
      count: Number(r.cnt),
    })),
  };
}

async function queryStats(tracker, from, to) {
  const src = await resolveSource(tracker, from, to);
  if (!src) return { error: `No data table found for tracker: ${tracker}` };
  const { source, table, fromStr, toStr, trackerParam } = src;
  const isPerTable = source === 'table';
  const whereCond = isPerTable
    ? 'recorded_at >= ? AND recorded_at <= ?'
    : 'tracker_id = ? AND recorded_at >= ? AND recorded_at <= ?';
  const params = isPerTable ? [fromStr, toStr] : [trackerParam, fromStr, toStr];
  const [[stat]] = await pool.execute(
    `SELECT MIN(heart_rate) AS min_hr, MAX(heart_rate) AS max_hr, ROUND(AVG(heart_rate), 1) AS avg_hr, COUNT(*) AS cnt, MIN(recorded_at) AS first_at, MAX(recorded_at) AS last_at FROM \`${table}\` WHERE ${whereCond}`,
    params
  );
  // Median via window functions (MariaDB 10.2+ / MySQL 8.0+)
  // Returns at most 2 rows (the two middle values), we average them
  const [medRows] = await pool.execute(
    `SELECT heart_rate FROM (SELECT heart_rate, ROW_NUMBER() OVER (ORDER BY heart_rate) AS rn, COUNT(*) OVER () AS total FROM \`${table}\` WHERE ${whereCond}) ranked WHERE rn BETWEEN FLOOR((total + 1) / 2) AND CEIL((total + 1) / 2)`,
    params
  );
  const median = medRows.length > 0
    ? Math.round(medRows.reduce((s, r) => s + Number(r.heart_rate), 0) / medRows.length)
    : null;
  return {
    min: Number(stat.min_hr),
    max: Number(stat.max_hr),
    avg: Number(stat.avg_hr),
    median,
    count: Number(stat.cnt),
    firstAt: stat.first_at,
    lastAt: stat.last_at,
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function respond(res, status, data, type = 'application/json') {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': type, ...CORS });
  res.end(body);
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 8192) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;
  if (req.method === 'OPTIONS') { respond(res, 204, ''); return; }
  try {
    // Serve the HTML page
    if (req.method === 'GET' && pathname === '/') {
      fs.readFile(path.join(__dirname, 'history.html'), 'utf8', (err, html) => {
        if (err) respond(res, 500, 'history.html not found in ServerGraph/', 'text/plain');
        else respond(res, 200, html, 'text/html; charset=utf-8');
      });
      return;
    }
    // DB connection status
    if (req.method === 'GET' && pathname === '/api/status') {
      const result = await testConnection();
      respond(res, 200, { connected: result.ok, host: config.dbHost, dbName: config.dbName, configured: !!(config.dbHost && config.dbUser) });
      return;
    }
    // List detected trackers
    if (req.method === 'GET' && pathname === '/api/trackers') {
      if (!pool) { respond(res, 200, { trackers: [] }); return; }
      respond(res, 200, { trackers: await detectTrackers() });
      return;
    }
    // Heart rate time series data
    if (req.method === 'GET' && pathname === '/api/heartrate') {
      const tracker = url.searchParams.get('tracker');
      const interval = url.searchParams.get('interval') || '1h';
      const from = parseDate(url.searchParams.get('from'));
      const to = parseDate(url.searchParams.get('to'));
      if (!tracker || !from || !to) { respond(res, 400, { error: 'Missing required params: tracker, from, to' }); return; }
      if (!VALID_INTERVALS.has(interval)) { respond(res, 400, { error: 'Invalid interval. Valid: raw, 5m, 1h, 1d' }); return; }
      if (!isValidTrackerId(tracker)) { respond(res, 400, { error: 'Invalid tracker ID format' }); return; }
      if (!pool) { respond(res, 503, { error: 'Not connected to database' }); return; }
      const result = await queryHeartrate(tracker, from, to, interval);
      respond(res, result.error ? 404 : 200, result);
      return;
    }
    // Summary statistics (min, max, avg, median, count)
    if (req.method === 'GET' && pathname === '/api/stats') {
      const tracker = url.searchParams.get('tracker');
      const from = parseDate(url.searchParams.get('from'));
      const to = parseDate(url.searchParams.get('to'));
      if (!tracker || !from || !to) { respond(res, 400, { error: 'Missing required params: tracker, from, to' }); return; }
      if (!isValidTrackerId(tracker)) { respond(res, 400, { error: 'Invalid tracker ID format' }); return; }
      if (!pool) { respond(res, 503, { error: 'Not connected to database' }); return; }
      const result = await queryStats(tracker, from, to);
      respond(res, result.error ? 404 : 200, result);
      return;
    }
    // Update DB connection settings
    if (req.method === 'POST' && pathname === '/api/connect') {
      const body = await readJson(req);
      const { host, port, user, password, dbName } = body;
      if (!host || !user || !dbName) { respond(res, 400, { error: 'Required fields: host, user, dbName' }); return; }
      config = {
        ...config,
        sqlEnabled: true,
        dbHost: String(host).slice(0, 255),
        dbPort: String(port || 3306).slice(0, 8),
        dbUser: String(user).slice(0, 64),
        dbPassword: String(password || ''),
        dbName: String(dbName).slice(0, 64),
      };
      saveConfig();
      initPool();
      const result = await testConnection();
      respond(res, 200, { connected: result.ok, message: result.ok ? 'Connected successfully' : `Connection failed: ${result.error}` });
      return;
    }
    respond(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[error]', err.message);
    respond(res, 500, { error: 'Internal server error', detail: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

loadConfig();
initPool();

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n  HypeRDesktop Heart Rate History');
  console.log(`  ➜  http://localhost:${PORT}\n`);
  if (!config.sqlEnabled || !config.dbHost) {
    console.log('  No database configured. Open the page and use the Connection panel.\n');
  }
});

server.on('error', err => {
  console.error('[fatal]', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error(`  Port ${PORT} already in use. Try:  PORT=3031 node ServerGraph/history-server.js`);
  }
  process.exit(1);
});
