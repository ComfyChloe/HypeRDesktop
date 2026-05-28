/**
 * transform-dump.js — Transforms a mysqldump of CODE_* tables into a
 * clean heartrate_log import file. Runs entirely on your local PC.
 *
 * BEFORE EXPORTING from phpMyAdmin:
 *   Export tab → Custom → uncheck "Extended inserts"
 *   (this gives one INSERT per row, which is required for streaming parse)
 *
 * Usage:
 *   node transform-dump.js dump.sql heartrate_log.sql
 *
 * Then reimport heartrate_log.sql via:
 *   phpMyAdmin → Import tab
 *   OR: mysql -h HOST -u USER -p DBNAME < heartrate_log.sql
 *
 * The output file contains only heartrate_log inserts — no other tables.
 * Original CODE_* tables are untouched.
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

// ─── Args ────────────────────────────────────────────────────────────────────

const [,, inputFile, outputFile = 'heartrate_log.sql'] = process.argv;

if (!inputFile) {
  console.error('Usage: node transform-dump.js dump.sql [heartrate_log.sql]');
  process.exit(1);
}
if (!fs.existsSync(inputFile)) {
  console.error(`File not found: ${inputFile}`);
  process.exit(1);
}

const fileSizeMb = (fs.statSync(inputFile).size / 1024 / 1024).toFixed(1);
console.log(`Input : ${inputFile} (${fileSizeMb} MB)`);
console.log(`Output: ${outputFile}`);
console.log('Processing...\n');

// ─── State ───────────────────────────────────────────────────────────────────

// Matches: INSERT INTO `CODE_abc123` VALUES ('time_text',heartrate);
//   or the rarer: INSERT INTO `CODE_abc123` VALUES ('time_text', heartrate);
const INSERT_RE = /^INSERT INTO `(CODE_[^`]+)` VALUES \('([^']+)',\s*(\d+)\);/;

// Detect extended-insert format (multiple rows on one line)
const EXTENDED_RE = /^INSERT INTO `CODE_[^`]+` VALUES .*\),\s*\(/;

let currentTracker  = null;
let currentDate     = '';   // last seen YYYY-MM-DD
let batch           = [];
let totalInserted   = 0;
let totalSkipped    = 0;
let linesRead       = 0;
let extendedWarned  = false;

const BATCH_SIZE = 1000;

// ─── Output stream ───────────────────────────────────────────────────────────

const out = fs.createWriteStream(outputFile, { encoding: 'utf8' });

out.write(`-- heartrate_log import\n`);
out.write(`-- Source : ${path.basename(inputFile)}\n`);
out.write(`-- Created: ${new Date().toISOString()}\n\n`);

out.write(
`CREATE TABLE IF NOT EXISTS heartrate_log (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tracker_id  VARCHAR(100) NOT NULL,
  recorded_at DATETIME NOT NULL,
  heart_rate  TINYINT UNSIGNED NOT NULL,
  INDEX idx_tracker_time (tracker_id, recorded_at),
  INDEX idx_recorded_at  (recorded_at)
);\n\n`
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function flushBatch() {
  if (!batch.length) return;
  const vals = batch
    .map(([t, d, h]) => `  ('${t}','${d}',${h})`)
    .join(',\n');
  out.write(`INSERT INTO heartrate_log (tracker_id, recorded_at, heart_rate) VALUES\n${vals};\n\n`);
  totalInserted += batch.length;
  batch = [];
}

function processRow(timeText, heartRate) {
  const tt = timeText.trim();

  if (tt.length === 19) {
    // Full format: YYYY-MM-DD HH:MM:SS
    currentDate = tt.slice(0, 10);
    batch.push([currentTracker, tt, heartRate]);
  } else if (tt.length === 8) {
    // Time only: HH:MM:SS — needs date context from a preceding full row
    if (!currentDate) {
      totalSkipped++;
      return;
    }
    batch.push([currentTracker, `${currentDate} ${tt}`, heartRate]);
  } else {
    totalSkipped++;
    return;
  }

  if (batch.length >= BATCH_SIZE) flushBatch();
}

// ─── Main parse loop ─────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: fs.createReadStream(inputFile, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  linesRead++;

  if (linesRead % 500_000 === 0) {
    process.stdout.write(
      `\r  Lines: ${(linesRead / 1e6).toFixed(1)}M | Rows inserted: ${totalInserted.toLocaleString()} | Skipped: ${totalSkipped}`
    );
  }

  // Detect extended-insert format and warn once
  if (!extendedWarned && EXTENDED_RE.test(line)) {
    extendedWarned = true;
    process.stdout.write('\n');
    console.warn('  WARNING: Extended inserts detected. This line will be skipped.');
    console.warn('  Re-export with "Extended inserts" UNCHECKED in phpMyAdmin.\n');
    return;
  }

  const match = line.match(INSERT_RE);
  if (!match) return;

  const [, tableName, timeText, hrStr] = match;
  const trackerId = tableName.replace(/^CODE_/, '');

  // New tracker table — flush current batch and reset date context
  if (trackerId !== currentTracker) {
    flushBatch();
    currentTracker = trackerId;
    currentDate    = '';
    process.stdout.write(`\n  Tracker: ${trackerId}`);
  }

  processRow(timeText, parseInt(hrStr, 10));
});

rl.on('close', () => {
  flushBatch();

  out.write(
`\n-- ── Verify ────────────────────────────────────────────────────
SELECT
  tracker_id,
  FORMAT(COUNT(*), 0)  AS total_rows,
  MIN(recorded_at)     AS first_reading,
  MAX(recorded_at)     AS last_reading
FROM heartrate_log
GROUP BY tracker_id
ORDER BY tracker_id;\n`
  );

  out.end(() => {
    const outMb = (fs.statSync(outputFile).size / 1024 / 1024).toFixed(1);
    process.stdout.write('\n\n');
    console.log('Done.');
    console.log(`  Rows inserted : ${totalInserted.toLocaleString()}`);
    console.log(`  Rows skipped  : ${totalSkipped.toLocaleString()} (no date anchor)`);
    console.log(`  Output size   : ${outMb} MB`);
    if (extendedWarned) {
      console.log('\n  ACTION NEEDED: Re-export with "Extended inserts" unchecked and re-run.');
    } else {
      console.log(`\nImport the output file:`);
      console.log(`  phpMyAdmin → Import → ${outputFile}`);
      console.log(`  OR: mysql -h HOST -u USER -p DBNAME < ${outputFile}`);
    }
  });
});
