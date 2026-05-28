/**
 * migrate.js — Parses the local mysqldump backup and generates migration.sql.
 *
 * WHY LOCAL BACKUP?
 *   Faster than server-side window functions on 24M rows across the network.
 *   All transformation (date propagation) happens on this machine; the server
 *   just receives clean INSERT statements for heartrate_log.
 *
 * Usage:
 *   node migrate.js              — reads D:\heartmonitor_backup.sql.gz,
 *                                  generates migration.sql in this directory
 *   Then import migration.sql:
 *     Get-Content migration.sql | ssh Chloe@192.168.100.125 \
 *       "/usr/local/mariadb10/bin/mysql -u root -p'Download12@' \
 *        -S /run/mysqld/mysqld10.sock heartmonitor"
 *
 * WHAT IT DOES:
 *   For each CODE_* table found in the backup:
 *     1. Detects column order from the CREATE TABLE statement.
 *     2. Parses every INSERT row, extracting time_text + heart_rate.
 *     3. Propagates the last-seen YYYY-MM-DD date to time-only HH:MM:SS rows.
 *     4. Emits batched INSERT INTO heartrate_log statements.
 *   Rows with no preceding date anchor are skipped (as on the server-side path).
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const zlib     = require('zlib');
const readline = require('readline');

const BACKUP_PATH = 'D:\\heartmonitor_backup.sql.gz';
const OUT_PATH    = path.join(__dirname, 'migration.sql');
const BATCH_SIZE  = 1000; // rows per INSERT statement

// ─── Parse individual column values from a mysqldump VALUES clause ────────────
// Yields { timeText, heartRate } for each row tuple found in the string.
// Handles quoted strings (with backslash escapes), NULL, and integers.
// Works with any column order — caller passes colTime / colHr indices.

function* parseRows(valuesStr, colTime, colHr) {
  const n = valuesStr.length;
  let i = 0;

  while (i < n) {
    // Advance to opening '('
    while (i < n && valuesStr[i] !== '(') i++;
    if (i >= n) break;
    i++; // consume '('

    const cols = [];

    // Read comma-separated values until matching ')'
    while (i < n && valuesStr[i] !== ')') {
      if (valuesStr[i] === ',') { i++; continue; }

      if (valuesStr[i] === "'") {
        // Quoted string
        i++;
        let s = '';
        while (i < n) {
          const c = valuesStr[i];
          if (c === '\\') { i++; s += valuesStr[i++]; }
          else if (c === "'") { i++; break; }
          else { s += c; i++; }
        }
        cols.push(s);
      } else if (valuesStr.slice(i, i + 4) === 'NULL') {
        cols.push(null);
        i += 4;
      } else {
        // Integer / float
        let num = '';
        while (i < n && valuesStr[i] !== ',' && valuesStr[i] !== ')') num += valuesStr[i++];
        cols.push(num);
      }
    }
    if (i < n) i++; // consume ')'

    if (cols.length === 0) continue;

    const tIdx = (colTime  >= 0 && colTime  < cols.length) ? colTime  : 0;
    const hIdx = (colHr    >= 0 && colHr    < cols.length) ? colHr    : 1;
    yield { timeText: cols[tIdx], heartRate: cols[hIdx] };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function generate() {
  if (!fs.existsSync(BACKUP_PATH)) {
    console.error(`Backup not found: ${BACKUP_PATH}`);
    process.exit(1);
  }

  const stat = fs.statSync(BACKUP_PATH);
  console.log(`Reading backup: ${BACKUP_PATH}  (${(stat.size / 1024 / 1024).toFixed(1)} MB compressed)`);
  console.log(`Output:         ${OUT_PATH}`);
  console.log('');

  const fileStream = fs.createReadStream(BACKUP_PATH);
  const gunzip     = zlib.createGunzip();
  const rl         = readline.createInterface({ input: fileStream.pipe(gunzip), crlfDelay: Infinity });

  const out = fs.createWriteStream(OUT_PATH, { encoding: 'utf8' });

  // ── SQL header ──────────────────────────────────────────────────────────
  out.write(
`-- ================================================================
-- HypeRDesktop heartrate_log migration
-- Generated: ${new Date().toISOString()}
-- Source:    ${BACKUP_PATH}
--
-- Import with:
--   Get-Content migration.sql | ssh Chloe@192.168.100.125 \`
--     "/usr/local/mariadb10/bin/mysql -u root -p'Download12@' \`
--      -S /run/mysqld/mysqld10.sock heartmonitor"
-- ================================================================

SET SESSION sql_mode = '';

CREATE TABLE IF NOT EXISTS heartrate_log (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tracker_id  VARCHAR(100) NOT NULL,
  recorded_at DATETIME NOT NULL,
  heart_rate  TINYINT UNSIGNED NOT NULL,
  INDEX idx_tracker_time (tracker_id, recorded_at),
  INDEX idx_recorded_at  (recorded_at)
);

`);

  // ── State ───────────────────────────────────────────────────────────────
  let currentTable  = null;  // CODE_* table name currently being read
  let trackerId     = null;  // e.g. '43B6'
  let lastDate      = null;  // 'YYYY-MM-DD' propagated from full timestamps
  let colTime       = 0;     // column index of time_text (detected from CREATE TABLE)
  let colHr         = 1;     // column index of heart_rate
  let inCreate      = false;
  let colIdx        = 0;

  let batch      = [];
  let totalRows  = 0;
  let skipped    = 0;
  const stats    = {};       // per-table row counts

  function flushBatch() {
    if (!batch.length) return;
    out.write('INSERT INTO heartrate_log (tracker_id, recorded_at, heart_rate) VALUES\n');
    out.write(batch.join(',\n') + ';\n');
    batch = [];
  }

  function processRow(timeText, heartRate) {
    if (timeText === null || heartRate === null) { skipped++; return; }

    let dt;
    const len = timeText.length;
    if (len === 19) {
      lastDate = timeText.slice(0, 10);
      dt = timeText;
    } else if (len === 8) {
      if (!lastDate) { skipped++; return; }
      dt = `${lastDate} ${timeText}`;
    } else {
      skipped++;
      return;
    }

    const hr = parseInt(heartRate, 10);
    if (isNaN(hr) || hr < 0 || hr > 255) { skipped++; return; }

    batch.push(`  ('${trackerId}','${dt}',${hr})`);
    totalRows++;
    stats[currentTable] = (stats[currentTable] || 0) + 1;
    if (batch.length >= BATCH_SIZE) flushBatch();
  }

  // ── Stream the backup line by line ─────────────────────────────────────
  let linesRead = 0;

  for await (const line of rl) {
    linesRead++;
    if (linesRead % 50000 === 0) process.stdout.write('.');

    // Detect table header comment
    const hdr = line.match(/^-- Table structure for table `([^`]+)`/);
    if (hdr) {
      flushBatch();
      const tbl = hdr[1];
      if (tbl.startsWith('CODE_')) {
        currentTable = tbl;
        trackerId    = tbl.replace(/^CODE_/, '');
        lastDate     = null;
        colTime      = 0;
        colHr        = 1;
        colIdx       = 0;
        inCreate     = false;
        process.stdout.write(`\nProcessing ${tbl} (tracker: ${trackerId})...`);
      } else {
        currentTable = null;
        trackerId    = null;
      }
      continue;
    }

    if (!currentTable) continue;

    // Detect CREATE TABLE to learn column order
    if (/^CREATE TABLE/.test(line)) {
      inCreate = true;
      colIdx   = 0;
      colTime  = 0;  // reset defaults
      colHr    = 1;
      continue;
    }
    if (inCreate) {
      if (/^\)/.test(line)) { inCreate = false; continue; }
      const col = line.match(/^\s+`([^`]+)`/);
      if (col) {
        if (col[1] === 'time_text')  colTime = colIdx;
        if (col[1] === 'heart_rate') colHr   = colIdx;
        colIdx++;
      }
      continue;
    }

    // Parse INSERT INTO ... VALUES ...
    if (line.startsWith('INSERT INTO')) {
      const vIdx = line.indexOf(' VALUES ');
      if (vIdx === -1) continue;
      const valuesStr = line.slice(vIdx + 8, -1); // strip trailing ';'

      for (const { timeText, heartRate } of parseRows(valuesStr, colTime, colHr)) {
        processRow(timeText, heartRate);
      }
    }
  }

  flushBatch();

  // ── Footer ──────────────────────────────────────────────────────────────
  out.write(`
-- ════════════════════════════════════════════════════════
-- Verify: row counts per tracker after migration
-- ════════════════════════════════════════════════════════
SELECT
  tracker_id,
  FORMAT(COUNT(*), 0)  AS total_rows,
  MIN(recorded_at)     AS first_reading,
  MAX(recorded_at)     AS last_reading
FROM heartrate_log
GROUP BY tracker_id
ORDER BY tracker_id;
`);
  out.end();

  // ── Summary ─────────────────────────────────────────────────────────────
  const sizeMb = (fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(1);
  console.log('\n\n=== Done ===');
  for (const [tbl, cnt] of Object.entries(stats)) {
    console.log(`  ${tbl.padEnd(16)} ${cnt.toLocaleString()} rows`);
  }
  console.log(`  ${'Skipped'.padEnd(16)} ${skipped.toLocaleString()} rows`);
  console.log(`  ${'Total'.padEnd(16)} ${totalRows.toLocaleString()} rows`);
  console.log(`\nGenerated: migration.sql  (${sizeMb} MB)`);
  console.log(`\nNext: pipe migration.sql to the NAS to import.`);
}

generate().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
