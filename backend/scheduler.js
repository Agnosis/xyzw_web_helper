'use strict';

const { getDb } = require('./database');
const { executeScheduledTask } = require('./game/executor');
const axios = require('axios');

/**
 * Check if a cron expression matches the given Date.
 * Format: "minute hour dayOfMonth month dayOfWeek"
 */
function matchesCron(expr, now) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minute, hour, dom, month, dow] = parts;
  const m = now.getMinutes();
  const h = now.getHours();
  const d = now.getDate();
  const mo = now.getMonth() + 1;
  const dw = now.getDay();

  return (
    matchField(minute, m, 0, 59) &&
    matchField(hour, h, 0, 23) &&
    matchField(dom, d, 1, 31) &&
    matchField(month, mo, 1, 12) &&
    matchField(dow, dw, 0, 6)
  );
}

function matchField(field, value, min, max) {
  if (field === '*') return true;

  // Handle step values like */5 or 1-5/2
  if (field.includes('/')) {
    const slashIdx = field.indexOf('/');
    const range = field.slice(0, slashIdx);
    const step = parseInt(field.slice(slashIdx + 1), 10);
    let lo, hi;
    if (range === '*') {
      lo = min;
      hi = max;
    } else {
      const dashParts = range.split('-');
      lo = parseInt(dashParts[0], 10);
      hi = parseInt(dashParts[1], 10);
    }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  }

  // Handle lists like 1,3,5
  if (field.includes(',')) {
    return field.split(',').some((f) => matchField(f.trim(), value, min, max));
  }

  // Handle ranges like 1-5
  if (field.includes('-')) {
    const dashParts = field.split('-');
    const lo = parseInt(dashParts[0], 10);
    const hi = parseInt(dashParts[1], 10);
    return value >= lo && value <= hi;
  }

  return parseInt(field, 10) === value;
}

/**
 * Check if the current time falls within a time window configuration.
 * If no window or window not enabled, always returns true.
 */
function isWithinTimeWindow(now, timeWindow) {
  if (!timeWindow || !timeWindow.enabled) return true;

  const day = now.getDay();
  if (timeWindow.days && timeWindow.days.length && !timeWindow.days.includes(day)) return false;

  if (!timeWindow.startTime || !timeWindow.endTime) return true;

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const startParts = timeWindow.startTime.split(':');
  const endParts = timeWindow.endTime.split(':');
  const sh = parseInt(startParts[0], 10);
  const sm = parseInt(startParts[1], 10);
  const eh = parseInt(endParts[0], 10);
  const em = parseInt(endParts[1], 10);

  return nowMin >= sh * 60 + sm && nowMin < eh * 60 + em;
}

// Track currently running task IDs to prevent double-execution
const runningTasks = new Set();

// Persist a scheduler system event to the DB (best-effort, non-blocking)
// Keeps only the latest 500 rows to avoid unbounded growth
function logSchedulerEvent(type, message) {
  console.log(`[Scheduler][${type}] ${message}`);
  try {
    const db = getDb();
    db.prepare('INSERT INTO scheduler_events (type, message, created_at) VALUES (?, ?, ?)').run(
      type,
      message,
      new Date().toISOString(),
    );
    // Trim old rows (keep latest 500)
    db.prepare(
      'DELETE FROM scheduler_events WHERE id NOT IN (SELECT id FROM scheduler_events ORDER BY id DESC LIMIT 500)',
    ).run();
  } catch (err) {
    // DB might not be ready yet during early startup; ignore
  }
}

async function checkAndRunTasks() {
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('[Scheduler] Database not available:', err.message);
    return;
  }

  const now = new Date();

  // Get all enabled tasks
  let tasks;
  try {
    tasks = db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1').all();
  } catch (err) {
    console.error('[Scheduler] Failed to query tasks:', err.message);
    return;
  }

  for (const task of tasks) {
    if (runningTasks.has(task.id)) continue; // already running

    // Parse and check time window
    let timeWindow = null;
    try {
      timeWindow = task.time_window ? JSON.parse(task.time_window) : null;
    } catch {
      timeWindow = null;
    }
    if (!isWithinTimeWindow(now, timeWindow)) continue;

    let shouldRun = false;

    if (task.run_type === 'daily' && task.run_time) {
      // Daily: check if current time matches HH:mm within this minute
      const timeParts = task.run_time.split(':');
      const targetH = parseInt(timeParts[0], 10);
      const targetM = parseInt(timeParts[1], 10);
      const currentH = now.getHours();
      const currentM = now.getMinutes();

      if (currentH === targetH && currentM === targetM) {
        // Check if already ran today
        const lastRun = task.last_run_at ? new Date(task.last_run_at) : null;
        const today = now.toDateString();
        if (!lastRun || lastRun.toDateString() !== today) {
          shouldRun = true;
        }
      }
    } else if (task.run_type === 'cron' && task.cron_expression) {
      // Cron: check if current minute matches
      if (matchesCron(task.cron_expression, now)) {
        // Check if already ran in this minute
        const lastRun = task.last_run_at ? new Date(task.last_run_at) : null;
        const thisMinute = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          now.getHours(),
          now.getMinutes(),
        );
        if (!lastRun || lastRun < thisMinute) {
          shouldRun = true;
        }
      }
    } else if (task.run_type === 'interval' && task.interval_minutes) {
      // Interval: run if enough time has passed since last run
      const intervalMs = task.interval_minutes * 60 * 1000;
      const lastRun = task.last_run_at ? new Date(task.last_run_at) : null;
      if (!lastRun || (now - lastRun) >= intervalMs) {
        shouldRun = true;
      }
    }

    if (!shouldRun) continue;

    // Mark task as running and record start time
    runningTasks.add(task.id);
    try {
      db.prepare('UPDATE scheduled_tasks SET last_run_at = ? WHERE id = ?').run(
        now.toISOString(),
        task.id,
      );
    } catch (err) {
      console.error(`[Scheduler] Failed to update last_run_at for task ${task.id}:`, err.message);
      runningTasks.delete(task.id);
      continue;
    }

    // Fetch user tokens and settings
    let userTokens = [];
    let batchSettings = {};
    try {
      const tokenRow = db
        .prepare('SELECT tokens_json FROM game_tokens WHERE user_id = ?')
        .get(task.user_id);
      const settingsRow = db
        .prepare('SELECT settings_json FROM user_settings WHERE user_id = ?')
        .get(task.user_id);
      userTokens = tokenRow ? JSON.parse(tokenRow.tokens_json || '[]') : [];
      batchSettings = settingsRow ? JSON.parse(settingsRow.settings_json || '{}') : {};
    } catch (err) {
      console.error(`[Scheduler] Failed to fetch tokens/settings for task ${task.id}:`, err.message);
      runningTasks.delete(task.id);
      continue;
    }

    // Create a log entry in the DB
    const logEntries = [];
    let logId;
    try {
      const result = db
        .prepare(
          'INSERT INTO task_logs (task_id, user_id, started_at, status, log_entries) VALUES (?, ?, ?, ?, ?)',
        )
        .run(task.id, task.user_id, now.toISOString(), 'running', JSON.stringify(logEntries));
      logId = result.lastInsertRowid;
    } catch (err) {
      console.error(`[Scheduler] Failed to create log entry for task ${task.id}:`, err.message);
      runningTasks.delete(task.id);
      continue;
    }

    const log = (message, type = 'info') => {
      console.log(`[Scheduler][Task ${task.id}] ${message}`);
      logEntries.push({ time: new Date().toLocaleTimeString(), message, type });
    };

    log(`开始执行任务: ${task.name}`);

    // Execute asynchronously - don't await here
    executeScheduledTask(task, userTokens, batchSettings, log)
      .then(() => {
        log('任务完成', 'success');
        try {
          db
            .prepare(
              'UPDATE task_logs SET finished_at = ?, status = ?, log_entries = ? WHERE id = ?',
            )
            .run(new Date().toISOString(), 'completed', JSON.stringify(logEntries), logId);
        } catch (err) {
          console.error(`[Scheduler] Failed to update log for task ${task.id}:`, err.message);
        }
      })
      .catch((err) => {
        log(`任务失败: ${err.message}`, 'error');
        try {
          db
            .prepare(
              'UPDATE task_logs SET finished_at = ?, status = ?, log_entries = ? WHERE id = ?',
            )
            .run(new Date().toISOString(), 'failed', JSON.stringify(logEntries), logId);
        } catch (dbErr) {
          console.error(`[Scheduler] Failed to update log for task ${task.id}:`, dbErr.message);
        }
      })
      .finally(() => {
        runningTasks.delete(task.id);
      });
  }
}

let schedulerInterval = null;
let watchdogInterval = null;
let lastTickAt = 0;
let tokenRefreshInterval = null;

// ── Token 自动刷新 ────────────────────────────────────────────────────────────
// 每天遍历所有用户的 token，对 URL 类型主动抓取刷新
const TOKEN_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function refreshUserTokens(log = console.log) {
  let db;
  try {
    db = getDb();
  } catch {
    return;
  }

  let rows;
  try {
    rows = db.prepare('SELECT user_id, tokens_json FROM game_tokens').all();
  } catch {
    return;
  }

  for (const row of rows) {
    let tokens = [];
    try {
      tokens = JSON.parse(row.tokens_json || '[]');
    } catch {
      continue;
    }

    let updated = false;
    for (const token of tokens) {
      // 仅刷新 URL 导入类型的 token
      if (token.importMethod === 'url' && token.sourceUrl) {
        try {
          const resp = await axios.get(token.sourceUrl, { timeout: 10000 });
          if (resp.data && resp.data.token && resp.data.token !== token.token) {
            token.token = resp.data.token;
            token.lastRefreshed = new Date().toISOString();
            updated = true;
            log(`[TokenRefresh] 刷新成功: ${token.name || token.id} (${token.importMethod})`);
          }
        } catch (err) {
          log(`[TokenRefresh] 刷新失败: ${token.name || token.id} - ${err.message}`);
        }
      }
      // bin / wxQrcode 类型的 token 后端没有原始数据，无法刷新，只能记录
      else if (token.importMethod === 'bin' || token.importMethod === 'wxQrcode') {
        log(`[TokenRefresh] 跳过无法刷新的 token: ${token.name || token.id} (${token.importMethod}) - 需要前端在线刷新`);
      }
    }

    if (updated) {
      try {
        db.prepare('UPDATE game_tokens SET tokens_json = ?, updated_at = datetime(\'now\') WHERE user_id = ?')
          .run(JSON.stringify(tokens), row.user_id);
        log(`[TokenRefresh] 已保存刷新后的 tokens (user_id=${row.user_id})`);
      } catch (err) {
        log(`[TokenRefresh] 保存 tokens 失败: ${err.message}`);
      }
    }
  }
}

function startTokenRefresh() {
  if (tokenRefreshInterval) return;
  // 启动后先等 3 分钟再第一次刷新（让系统先稳定）
  setTimeout(() => {
    refreshUserTokens((msg) => logSchedulerEvent('token_refresh', msg));
  }, 3 * 60 * 1000);
  tokenRefreshInterval = setInterval(() => {
    refreshUserTokens((msg) => logSchedulerEvent('token_refresh', msg));
  }, TOKEN_REFRESH_INTERVAL_MS);
  logSchedulerEvent('token_refresh', `Token 刷新服务已启动（间隔 ${TOKEN_REFRESH_INTERVAL_MS / 60000} 分钟）`);
}

// ── Watchdog ────────────────────────────────────────────────────────────────
// 每 2 分钟检测一次调度器是否存活，如果超过 3 分钟没有 tick 则自动重启
const WATCHDOG_INTERVAL_MS = 2 * 60 * 1000;
const TICK_TIMEOUT_MS = 3 * 60 * 1000;

function startWatchdog() {
  if (watchdogInterval) return;
  watchdogInterval = setInterval(() => {
    const now = Date.now();
    if (lastTickAt > 0 && now - lastTickAt > TICK_TIMEOUT_MS) {
      logSchedulerEvent('watchdog', `调度器无响应 ${Math.round((now - lastTickAt) / 1000)}s，已自动重启`);
      if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
      }
      _startInterval();
    }
  }, WATCHDOG_INTERVAL_MS);
}

// ── Heartbeat ───────────────────────────────────────────────────────────────
// 每 10 分钟打印一次心跳日志，确认调度器在运行
let heartbeatCount = 0;
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;
let heartbeatInterval = null;

function startHeartbeat() {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => {
    heartbeatCount++;
    logSchedulerEvent('heartbeat', `调度器运行正常 #${heartbeatCount}`);
  }, HEARTBEAT_INTERVAL_MS);
}

// ── 进程级异常保护 ────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[Scheduler] uncaughtException:', err);
  // 不让进程崩溃，继续运行
});

process.on('unhandledRejection', (reason) => {
  console.error('[Scheduler] unhandledRejection:', reason);
});

// ── 实际调度循环 ───────────────────────────────────────────────────────────────
function _startInterval() {
  schedulerInterval = setInterval(async () => {
    lastTickAt = Date.now();
    await checkAndRunTasks();
  }, 30000);
}

function startScheduler() {
  if (schedulerInterval) return;

  // 清理上次崩溃遗留的 running 状态
  try {
    const db = getDb();
    db.prepare("UPDATE task_logs SET finished_at = ?, status = 'failed' WHERE status = 'running'")
      .run(new Date().toISOString());
  } catch (err) {
    console.error('[Scheduler] Failed to clean up stuck tasks:', err.message);
  }

  logSchedulerEvent('startup', '后台调度器已启动（30秒轮询间隔）');
  _startInterval();
  lastTickAt = Date.now();

  // 启动后 5 秒先跑一次
  setTimeout(async () => {
    lastTickAt = Date.now();
    await checkAndRunTasks();
  }, 5000);

  startWatchdog();
  startHeartbeat();
  startTokenRefresh();
}

function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (tokenRefreshInterval) {
    clearInterval(tokenRefreshInterval);
    tokenRefreshInterval = null;
  }
}

module.exports = { startScheduler, stopScheduler };
