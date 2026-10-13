const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use((req, res, next) => {
  const assets = global.POMODORO_ASSETS;
  if (!assets || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
  let name = decodeURIComponent(req.path);
  if (name === '/') name = '/index.html';
  name = name.replace(/^\/+/, '');
  if (name.includes('..') || !Object.prototype.hasOwnProperty.call(assets, name)) return next();
  res.type(path.extname(name)).send(assets[name]);
});
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Config ----------
const HOME = process.env.POMODORO_HOME || __dirname;
const CONFIG_PATH = path.join(HOME, 'config.json');
function breakMinutesOf(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 24 * 60 ? n : 30;
}
function pick(v, ok, d) { return ok.includes(v) ? v : d; }
function volumeOf(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : d;
}
function uiOf(raw) {
  const sounds = ['none', 'kitchen', 'bell', 'digital', 'chime', 'soft'];
  const repeat = parseInt(raw.alarmRepeat, 10);
  return {
    alarmSound: pick(raw.alarmSound, sounds, 'kitchen'),
    alarmVolume: volumeOf(raw.alarmVolume, 70),
    alarmRepeat: Number.isFinite(repeat) ? Math.max(1, Math.min(10, repeat)) : 1,
    focusSound: pick(raw.focusSound, sounds, 'soft'),
    focusVolume: volumeOf(raw.focusVolume, 50),
    theme: pick(raw.theme, ['red', 'teal', 'blue'], 'red'),
    hourFormat: raw.hourFormat === '12' ? '12' : '24',
    darkWhenRunning: !!raw.darkWhenRunning
  };
}
function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    raw = { ollamaUrl: 'http://127.0.0.1:11434', model: '', breakMinutes: 30 };
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
  }
  return {
    ollamaUrl: String(raw.ollamaUrl || 'http://127.0.0.1:11434').trim().replace(/\/$/, ''),
    model: String(raw.model || '').trim(),
    breakMinutes: breakMinutesOf(raw.breakMinutes),
    ...uiOf(raw)
  };
}
function ollamaBase(override) {
  const raw = String(override || config.ollamaUrl || 'http://127.0.0.1:11434').trim();
  return raw.replace(/\/$/, '');
}
const config = loadConfig();

// ---------- Timers ----------
const TIMERS_PATH = path.join(HOME, 'timers.json');
function loadTimers() {
  try {
    const arr = JSON.parse(fs.readFileSync(TIMERS_PATH, 'utf8'));
    if (Array.isArray(arr) && arr.length) return arr.map(t => ({ ...t, running: false, startedAt: null, remainingAtStart: null }));
  } catch { /* ignore */ }
  return [
    { id: 1, name: '专注', duration: 25 * 60, remaining: 25 * 60, running: false, startedAt: null, remainingAtStart: null }
  ];
}
let timers = loadTimers();
let nextId = timers.reduce((m, t) => Math.max(m, t.id), 0) + 1;

function saveTimers() {
  fs.writeFileSync(TIMERS_PATH, JSON.stringify(timers, null, 2));
}

const HISTORY_PATH = path.join(HOME, 'history.json');
function readHistory() {
  try {
    const arr = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function logFinish(t, now) {
  const seconds = Number(t.duration) || 0;
  if (seconds <= 0) return;
  const log = readHistory();
  log.push({ at: now, name: String(t.name || ''), seconds });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(log.length > 5000 ? log.slice(-5000) : log));
}
function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}
function streakOf(log, now) {
  const days = new Set(log.map(e => dayKey(e.at)));
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  if (!days.has(dayKey(cursor.getTime()))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!days.has(dayKey(cursor.getTime()))) return 0;
  }
  let n = 0;
  while (days.has(dayKey(cursor.getTime()))) {
    n++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return n;
}
function rangeWindow(range, offset, now) {
  const d = new Date(now);
  if (range === 'year') {
    const y = d.getFullYear() + offset;
    return { start: new Date(y, 0, 1).getTime(), end: new Date(y + 1, 0, 1).getTime(), title: offset === 0 ? '今年' : y + '年', slots: 12 };
  }
  if (range === 'month') {
    const start = new Date(d.getFullYear(), d.getMonth() + offset, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const title = offset === 0 ? '本月' : (start.getMonth() + 1) + '月';
    return { start: start.getTime(), end: end.getTime(), title, slots: Math.round((end - start) / 86400000) };
  }
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  monday.setDate(monday.getDate() + offset * 7);
  const end = new Date(monday);
  end.setDate(end.getDate() + 7);
  const title = offset === 0 ? '本周' : (monday.getMonth() + 1) + '/' + monday.getDate();
  return { start: monday.getTime(), end: end.getTime(), title, slots: 7 };
}
function buildReport(log, now, range, offset) {
  const win = rangeWindow(range, offset, now);
  const inRange = log.filter(e => e.at >= win.start && e.at < win.end);
  const seconds = log.reduce((s, e) => s + (Number(e.seconds) || 0), 0);
  const buckets = Array.from({ length: win.slots }, (_, i) => ({ label: '', hours: 0 }));
  const names = '一二三四五六日';
  if (range === 'week') buckets.forEach((b, i) => { b.label = names[i]; });
  else if (range === 'year') buckets.forEach((b, i) => { b.label = String(i + 1); });
  else buckets.forEach((b, i) => { b.label = String(i + 1); });
  for (const e of inRange) {
    const dt = new Date(e.at);
    let i = 0;
    if (range === 'year') i = dt.getMonth();
    else if (range === 'month') i = dt.getDate() - 1;
    else i = (dt.getDay() + 6) % 7;
    if (buckets[i]) buckets[i].hours += (Number(e.seconds) || 0) / 3600;
  }
  const detail = inRange.slice().sort((a, b) => b.at - a.at).slice(0, 40).map(e => ({
    name: e.name, at: e.at, minutes: Math.round((Number(e.seconds) || 0) / 60)
  }));
  return {
    hours: Math.round(seconds / 360) / 10,
    days: new Set(log.map(e => dayKey(e.at))).size,
    streak: streakOf(log, now),
    title: win.title,
    buckets,
    detail
  };
}

function snapshot() {
  const now = Date.now();
  return timers.map(t => {
    if (t.running) {
      return { ...t, remaining: Math.max(0, t.remainingAtStart - Math.floor((now - t.startedAt) / 1000)) };
    }
    return { ...t, remaining: t.remaining };
  });
}

// ---------- SSE ----------
const clients = new Set();
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('data: ' + JSON.stringify({ type: 'timers', timers: snapshot() }) + '\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
function broadcast() {
  const payload = 'data: ' + JSON.stringify({ type: 'timers', timers: snapshot() }) + '\n\n';
  for (const c of clients) { try { c.write(payload); } catch { /* ignore */ } }
}

// server-side tick: finish timers that hit zero
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const t of timers) {
    if (t.running) {
      const remaining = t.remainingAtStart - Math.floor((now - t.startedAt) / 1000);
      if (remaining <= 0) {
        t.running = false; t.remaining = 0; t.startedAt = null; t.remainingAtStart = null; t.finishedAt = now;
        logFinish(t, now);
        changed = true;
      }
    }
  }
  if (changed) { saveTimers(); broadcast(); }
}, 500);

// ---------- Actions ----------
function findTimer(name) {
  const s = String(name || '').trim();
  if (!s) return null;
  return timers.find(t => t.name === s)
    || timers.find(t => t.name.includes(s) || s.includes(t.name));
}

function applyActions(actions) {
  const results = [];
  for (const a of actions || []) {
    const r = { type: a.type, ok: false };
    switch (a.type) {
      case 'add': {
        const name = String(a.name || '').trim();
        const minutes = Number(a.minutes);
        if (!name || !Number.isFinite(minutes) || minutes <= 0) { r.error = '参数无效'; break; }
        if (findTimer(name)) { r.error = '已存在同名计时器'; break; }
        timers.push({ id: nextId++, name, duration: Math.round(minutes * 60), remaining: Math.round(minutes * 60), running: false, startedAt: null, remainingAtStart: null });
        r.ok = true; r.name = name;
        break;
      }
      case 'remove': {
        const t = findTimer(a.name);
        if (!t) { r.error = '未找到计时器'; break; }
        timers = timers.filter(x => x.id !== t.id);
        r.ok = true; r.name = t.name;
        break;
      }
      case 'start': {
        const t = findTimer(a.name);
        if (!t) { r.error = '未找到计时器'; break; }
        if (t.running) { r.ok = true; r.name = t.name; break; }
        if (t.remaining <= 0) t.remaining = t.duration;
        t.running = true; t.startedAt = Date.now(); t.remainingAtStart = t.remaining;
        r.ok = true; r.name = t.name;
        break;
      }
      case 'pause': {
        const t = findTimer(a.name);
        if (!t) { r.error = '未找到计时器'; break; }
        if (!t.running) { r.error = '未在运行'; break; }
        t.remaining = Math.max(0, t.remainingAtStart - Math.floor((Date.now() - t.startedAt) / 1000));
        t.running = false; t.startedAt = null; t.remainingAtStart = null;
        r.ok = true; r.name = t.name;
        break;
      }
      case 'reset': {
        const t = findTimer(a.name);
        if (!t) { r.error = '未找到计时器'; break; }
        t.running = false; t.remaining = t.duration; t.startedAt = null; t.remainingAtStart = null; t.finishedAt = null;
        r.ok = true; r.name = t.name;
        break;
      }
      case 'set': {
        const t = findTimer(a.name);
        const minutes = Number(a.minutes);
        if (!t) { r.error = '未找到计时器'; break; }
        if (!Number.isFinite(minutes) || minutes <= 0) { r.error = '参数无效'; break; }
        t.duration = Math.round(minutes * 60);
        if (!t.running) t.remaining = t.duration;
        r.ok = true; r.name = t.name;
        break;
      }
      case 'countdown': {
        const name = String(a.name || '').trim();
        const timeStr = String(a.time || '').trim();
        if (!name || !timeStr) { r.error = '参数无效, 需要 name 和 time(HH:MM)'; break; }
        const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
        if (!m) { r.error = '时间格式无效, 请使用 HH:MM'; break; }
        const targetHour = parseInt(m[1], 10);
        const targetMin = parseInt(m[2], 10);
        if (targetHour > 23 || targetMin > 59) { r.error = '时间无效'; break; }
        if (findTimer(name)) { r.error = '已存在同名计时器'; break; }
        const now = new Date();
        const target = new Date(now);
        target.setHours(targetHour, targetMin, 0, 0);
        let seconds = Math.floor((target - now) / 1000);
        if (seconds <= 0) { target.setDate(target.getDate() + 1); seconds = Math.floor((target - now) / 1000); }
        timers.push({ id: nextId++, name, duration: seconds, remaining: seconds, running: true, startedAt: Date.now(), remainingAtStart: seconds });
        r.ok = true; r.name = name;
        break;
      }
      default: r.error = '未知操作 ' + a.type;
    }
    results.push(r);
  }
  if (results.length) { saveTimers(); broadcast(); }
  return results;
}

// ---------- LLM ----------
function buildSystemPrompt() {
  const list = timers.map(t => {
    const now = Date.now();
    const remaining = t.running ? t.remainingAtStart - Math.floor((now - t.startedAt) / 1000) : t.remaining;
    return { name: t.name, totalMinutes: t.duration / 60, remainingSeconds: Math.max(0, remaining), running: t.running };
  });
  const now = new Date();
  const nowStr = now.toTimeString().slice(0, 5);
  return `你是番茄钟助手, 负责管理一组计时器。
当前时间: ${nowStr}
当前计时器列表: ${JSON.stringify(list)}
根据用户消息, 只输出一个 JSON 对象, 格式:
{"reply":"用简短中文回复用户","actions":[...]}
actions 中可用的操作:
{"type":"add","name":"名称","minutes":分钟数}
{"type":"remove","name":"名称"}
{"type":"start","name":"名称"}
{"type":"pause","name":"名称"}
{"type":"reset","name":"名称"}
{"type":"set","name":"名称","minutes":分钟数}
{"type":"countdown","name":"名称","time":"HH:MM"}
规则:
- 如果没有需要执行的操作, actions 为 []
- name 必须与列表中的名称一致; add/countdown 时为用户指定的新名称
- 用户说"N分钟倒计时"时, 先 add 再 start, 不要用 countdown。例如用户说"20分钟倒计时":
{"reply":"已开始 20 分钟倒计时","actions":[{"type":"add","name":"20分钟","minutes":20},{"type":"start","name":"20分钟"}]}
- 用户说"到X点"/"X点半休息"等, 用 countdown。time 用 24 小时制: 没说下午或晚上时, 11点半写成 11:30, 不要写成 23:30
- 只输出 JSON, 不要输出任何其它文字或 markdown`;
}

function extractText(data) {
  const m = data && data.message;
  if (m && typeof m.content === 'string' && m.content.trim()) return m.content;
  if (m && typeof m.thinking === 'string' && m.thinking.trim()) return m.thinking;
  return JSON.stringify(data);
}

function parseCnHour(s) {
  if (/^\d{1,2}$/.test(s)) return Number(s);
  const n = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === '十') return 10;
  if (s.startsWith('十')) return 10 + (n[s[1]] || 0);
  const i = s.indexOf('十');
  if (i > 0) return (n[s[0]] || 0) * 10 + (n[s[i + 1]] || 0);
  return n[s];
}
function secondsUntil(now, hour, minute) {
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  let sec = Math.floor((target - now) / 1000);
  if (sec <= 0) {
    target.setDate(target.getDate() + 1);
    sec = Math.floor((target - now) / 1000);
  }
  return sec;
}
// 没说下午/晚上时，11点半取离现在最近的 11:30 或 23:30。
function clockFromText(text, now) {
  const m = String(text).match(/(凌晨|早上|上午|中午|下午|傍晚|晚上|今晚)?\s*(\d{1,2}|[零一二两三四五六七八九十]{1,3})\s*点\s*(半|一刻|三刻|(\d{1,2})\s*分)?/);
  if (!m) return null;
  let hour = parseCnHour(m[2]);
  if (!Number.isInteger(hour) || hour > 23) return null;
  let minute = 0;
  if (m[3] === '半') minute = 30;
  else if (m[3] === '一刻') minute = 15;
  else if (m[3] === '三刻') minute = 45;
  else if (m[4]) minute = Number(m[4]);
  if (minute > 59) return null;
  const period = m[1] || '';
  let hours;
  if (period === '下午' || period === '傍晚') hours = [hour < 12 ? hour + 12 : hour];
  else if (period === '晚上' || period === '今晚') hours = [hour === 12 ? 0 : (hour < 12 ? hour + 12 : hour)];
  else if (period === '凌晨') hours = [hour === 12 ? 0 : hour % 12];
  else if (period === '中午') hours = [hour >= 1 && hour <= 4 ? hour + 12 : hour];
  else if (period === '早上' || period === '上午') hours = [hour % 12];
  else if (hour >= 13 || hour === 12) hours = [hour];
  else hours = [hour, hour + 12];
  let best = null;
  for (const h of hours) {
    if (h > 23) continue;
    const sec = secondsUntil(now, h, minute);
    if (!best || sec < best.sec) best = { sec, h, minute };
  }
  if (!best) return null;
  return String(best.h).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

async function callLLM(userMessage) {
  if (!config.model) throw new Error('请先在设置里选择 Ollama 模型');
  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: userMessage }
    ],
    stream: false,
    format: 'json',
    think: false
  };
  let resp = await fetch(ollamaBase() + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  let text = await resp.text();
  if (!resp.ok && /think/i.test(text)) {
    delete payload.think;
    resp = await fetch(ollamaBase() + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    text = await resp.text();
  }
  if (!resp.ok) throw new Error('LLM HTTP ' + resp.status + ': ' + text.slice(0, 500));
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('LLM 返回非 JSON: ' + text.slice(0, 200)); }
  return extractText(data);
}

app.post('/api/chat', async (req, res) => {
  const message = String((req.body && req.body.message) || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const raw = await callLLM(message);
    const parsed = extractJson(raw);
    if (!parsed) return res.json({ reply: raw, actions: [] });
    const clock = clockFromText(message, new Date());
    if (clock && Array.isArray(parsed.actions)) {
      for (const a of parsed.actions) if (a && a.type === 'countdown') a.time = clock;
    }
    const results = applyActions(parsed.actions);
    const reply = String(parsed.reply || (results.some(r => r.ok) ? '已处理' : ''));
    res.json({ reply, actions: results });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------- Direct action API (no LLM, instant) ----------
app.post('/api/action', (req, res) => {
  const body = req.body || {};
  const type = String(body.type || '').trim();
  if (!type) return res.status(400).json({ error: 'type required' });
  const action = { type, name: body.name, minutes: body.minutes, time: body.time };
  const results = applyActions([action]);
  res.json({ actions: results });
});

app.get('/api/report', (req, res) => {
  const range = ['week', 'month', 'year'].includes(req.query.range) ? req.query.range : 'week';
  const offset = Math.max(-520, Math.min(0, parseInt(req.query.offset, 10) || 0));
  res.json(buildReport(readHistory(), Date.now(), range, offset));
});

app.get('/api/models', async (req, res) => {
  try {
    const resp = await fetch(ollamaBase(req.query.url) + '/api/tags');
    const text = await resp.text();
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + text.slice(0, 200));
    const data = JSON.parse(text);
    const models = (data.models || []).map(m => m.name).filter(Boolean);
    res.json({ models });
  } catch (e) {
    res.status(502).json({ error: '连不上 Ollama: ' + e.message, models: [] });
  }
});

// ---------- Config API ----------
app.get('/api/config', (req, res) => res.json(config));
app.put('/api/config', (req, res) => {
  const body = req.body || {};
  if (typeof body.ollamaUrl === 'string' && body.ollamaUrl.trim()) {
    config.ollamaUrl = body.ollamaUrl.trim().replace(/\/$/, '');
  }
  if (typeof body.model === 'string') config.model = body.model.trim();
  if (body.breakMinutes != null) config.breakMinutes = breakMinutesOf(body.breakMinutes);
  Object.assign(config, uiOf(Object.assign({}, config, body)));
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  res.json({ ok: true });
});

if (process.env.POMODORO_SELFTEST) {
  const now = new Date(2026, 9, 13, 15).getTime();
  const day = 86400000;
  const log = [
    { at: now - 2 * day, name: '休息', seconds: 5 * 60 },
    { at: now - day, name: '专注', seconds: 25 * 60 },
    { at: now - 3600000, name: '专注', seconds: 50 * 60 }
  ];
  const s = buildReport(log, now, 'week', 0);
  if (s.days !== 3 || s.streak !== 3 || s.hours !== 1.3 || s.buckets.length !== 7) {
    throw new Error('report self-check failed ' + JSON.stringify({ days: s.days, streak: s.streak, hours: s.hours }));
  }
  const at1042 = new Date(2026, 9, 13, 10, 42, 0);
  if (clockFromText('11点半休息', at1042) !== '11:30') throw new Error('11点半应是上午');
  if (clockFromText('晚上11点半', at1042) !== '23:30') throw new Error('晚上11点半应是 23:30');
  console.log('report ok');
  process.exit(0);
}

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log('Pomodoro AI running at http://localhost:' + PORT);
});
server.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.log('端口 ' + PORT + ' 已在使用，沿用已有服务');
  // ponytail: 进程必须活着，否则 tauri dev 会因为 beforeDevCommand 退出而中断
  setInterval(() => {}, 60 * 60 * 1000);
});
