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
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Config ----------
const CONFIG_PATH = path.join(__dirname, 'config.json');
function breakMinutesOf(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 24 * 60 ? n : 30;
}
function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return {
    ollamaUrl: String(raw.ollamaUrl || 'http://127.0.0.1:11434').trim().replace(/\/$/, ''),
    model: String(raw.model || '').trim(),
    breakMinutes: breakMinutesOf(raw.breakMinutes)
  };
}
function ollamaBase(override) {
  const raw = String(override || config.ollamaUrl || 'http://127.0.0.1:11434').trim();
  return raw.replace(/\/$/, '');
}
const config = loadConfig();

// ---------- Timers ----------
const TIMERS_PATH = path.join(__dirname, 'timers.json');
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
        if (t.running) { r.error = '已在运行中'; break; }
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
        timers.push({ id: nextId++, name, duration: seconds, remaining: seconds, running: false, startedAt: null, remainingAtStart: null });
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
- 用户说"下班倒计时"/"到X点倒计时"等, 才用 countdown, time 填目标时间 HH:MM
- 只输出 JSON, 不要输出任何其它文字或 markdown`;
}

function extractText(data) {
  const m = data && data.message;
  if (m && typeof m.content === 'string' && m.content.trim()) return m.content;
  if (m && typeof m.thinking === 'string' && m.thinking.trim()) return m.thinking;
  return JSON.stringify(data);
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  res.json({ ok: true });
});

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
