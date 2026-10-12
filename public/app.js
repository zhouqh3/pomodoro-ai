const timersEl = document.getElementById('timers');
const chatBox = document.getElementById('chat-box');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');

// 桌面窗口从本地文件加载时，API 在 localhost:3000；浏览器直接访问则用相对路径
const BASE = /(^https?:\/\/[^/]*):3000/.test(window.location.href) ? '' : 'http://localhost:3000';


function fmt(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h > 0) return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function escAttr(s) { return s.replace(/"/g, '&quot;'); }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTimers(timers) {
  if (!timers.length) {
    timersEl.innerHTML = '<div class="empty">还没有计时器，在下方对话里告诉 AI 添加一个</div>';
    syncMini();
    return;
  }
  timersEl.innerHTML = timers.map(t => {
    const done = !t.running && t.remaining <= 0;
    const cls = t.running ? 'running' : (done ? 'done' : '');
    const status = t.running ? '运行中' : (done ? '已完成' : (t.remaining < t.duration ? '已暂停' : '待开始'));
    const totalMin = Math.round(t.duration / 60);
    const startBtn = t.running
      ? '<button class="icon-btn" data-act="pause" data-name="' + escAttr(t.name) + '" title="暂停"><svg viewBox="0 0 16 16"><path d="M4.5 3h2.2v10H4.5zm4.8 0H11.5v10H9.3z"/></svg></button>'
      : '<button class="icon-btn" data-act="start" data-name="' + escAttr(t.name) + '" title="开始"><svg viewBox="0 0 16 16"><path d="M5 3.2v9.6L13 8z"/></svg></button>';
    return [
      '<div class="timer-card ' + cls + '" data-id="' + t.id + '">',
      '  <div class="timer-info">',
      '    <div class="timer-name">' + escapeHtml(t.name) + '</div>',
      '    <div class="timer-status">' + status + ' · ' + totalMin + ' 分钟</div>',
      '  </div>',
      '  <div class="timer-time">' + fmt(Math.max(0, t.remaining)) + '</div>',
      '  <div class="timer-actions">',
      startBtn,
      '    <button class="icon-btn" data-act="reset" data-name="' + escAttr(t.name) + '" title="重置"><svg viewBox="0 0 16 16"><path d="M8 3.2a4.8 4.8 0 1 1-4.2 7.1.8.8 0 1 0-1.4.8A6.4 6.4 0 1 0 3.2 4.7V3.2H1.6V7h3.8V5.4H4.1A4.8 4.8 0 0 1 8 3.2z"/></svg></button>',
      '    <button class="icon-btn danger" data-act="remove" data-name="' + escAttr(t.name) + '" title="删除"><svg viewBox="0 0 16 16"><path d="M4 4.8 4.8 4 8 7.2 11.2 4l.8.8L8.8 8l3.2 3.2-.8.8L8 8.8l-3.2 3.2-.8-.8L7.2 8z"/></svg></button>',
      '  </div>',
      '</div>'
    ].join('\n');
  }).join('');
  syncMini();
}

function parseFmt(text) {
  const p = text.split(':').map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  return (p[0] || 0) * 60 + (p[1] || 0);
}

function syncMini() {
  const mini = document.getElementById('mini');
  const el = document.getElementById('mini-time');
  const cards = [...document.querySelectorAll('.timer-time')];
  const running = [...document.querySelectorAll('.timer-card.running .timer-time')];
  const pool = running.length ? running : cards;
  mini.classList.toggle('live', running.length > 0);
  if (!pool.length) {
    el.textContent = '00:00';
    mini.classList.remove('done');
    fitMiniWindow();
    return;
  }
  let best = null;
  for (const node of pool) {
    const sec = parseFmt(node.textContent);
    if (!best || sec < best.sec) best = { sec, text: node.textContent };
  }
  el.textContent = best.text;
  mini.classList.toggle('done', !running.length && best.sec <= 0);
  fitMiniWindow();
}

let miniBox = '';
function fitMiniWindow() {
  if (!window.matchMedia('(max-width: 280px)').matches) return;
  const api = window.__TAURI_INTERNALS__;
  if (!api) return;
  const box = document.getElementById('mini-time').getBoundingClientRect();
  const width = Math.ceil(box.width) + 12;
  const height = Math.ceil(box.height) + 8;
  const key = width + 'x' + height;
  if (key === miniBox || width < 8) return;
  miniBox = key;
  api.invoke('fit_compact', { width, height });
}

document.getElementById('add-timer').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = document.getElementById('add-error');
  const name = document.getElementById('add-name').value.trim();
  const minutes = Number(document.getElementById('add-minutes').value);
  errEl.textContent = '';
  if (!name || !Number.isFinite(minutes) || minutes <= 0) {
    errEl.textContent = '请填写名称和大于 0 的分钟数';
    return;
  }
  const resp = await fetch(BASE + '/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'add', name, minutes })
  });
  const data = await resp.json();
  const result = data.actions && data.actions[0];
  if (!result || !result.ok) {
    errEl.textContent = (result && result.error) || '添加失败';
    return;
  }
  document.getElementById('add-name').value = '';
});

timersEl.addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  await fetch(BASE + '/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: btn.dataset.act, name: btn.dataset.name })
  });
});

// ---- Chat ----
function addMsg(role, text, results) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  if (results && results.length) {
    const d = document.createElement('div');
    d.className = 'actions';
    d.innerHTML = results.map(r =>
      r.ok
        ? '<div class="ok">✓ ' + escapeHtml(r.type + ' ' + (r.name || '')) + '</div>'
        : '<div class="err">✗ ' + escapeHtml(r.type) + ': ' + escapeHtml(r.error || '') + '</div>'
    ).join('');
    div.appendChild(d);
  }
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  addMsg('user', text);
  sendBtn.disabled = true;
  addMsg('ai', '思考中…');
  const pending = chatBox.lastElementChild;
  try {
    const resp = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '请求失败');
    pending.remove();
    addMsg('ai', data.reply || '(无回复)', data.actions);
  } catch (e) {
    pending.remove();
    addMsg('ai', '出错了: ' + e.message);
  } finally {
    sendBtn.disabled = false;
    chatInput.focus();
  }
}
sendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

// ---- SSE ----
let audioCtx;
let seenRunning = new Set();

document.addEventListener('pointerdown', () => {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}, { once: true });

function ding() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  if (!audioCtx) audioCtx = new Ctx();
  const play = () => {
    const now = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = 988;
    o.connect(g);
    g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.07, now + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    o.start(now);
    o.stop(now + 0.23);
  };
  if (audioCtx.state === 'suspended') audioCtx.resume().then(play).catch(() => {});
  else play();
}

function noteFinish(timers) {
  const nowRunning = new Set();
  let finished = false;
  for (const t of timers) {
    if (t.running) nowRunning.add(t.id);
    else if (seenRunning.has(t.id) && t.remaining <= 0) finished = true;
  }
  seenRunning = nowRunning;
  if (finished) ding();
}

function connectSSE() {
  const es = new EventSource(BASE + '/api/events');
  es.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'timers') {
        noteFinish(d.timers);
        renderTimers(d.timers);
      }
    } catch { /* ignore */ }
  };
  es.onerror = () => { es.close(); setTimeout(connectSSE, 3000); };
}
connectSSE();

setInterval(() => {
  document.querySelectorAll('.timer-card.running').forEach(card => {
    const timeEl = card.querySelector('.timer-time');
    const parts = timeEl.textContent.split(':').map(Number);
    let total = 0;
    for (const p of parts) total = total * 60 + p;
    if (total > 0) timeEl.textContent = fmt(total - 1);
  });
  syncMini();
}, 1000);

const miniEl = document.getElementById('mini');
miniEl.addEventListener('mousedown', e => {
  if (e.button !== 0 || e.detail !== 1) return;
  const api = window.__TAURI_INTERNALS__;
  if (!api) return;
  e.preventDefault();
  api.invoke('drag_window');
});
miniEl.addEventListener('dblclick', e => {
  const api = window.__TAURI_INTERNALS__;
  if (!api) return;
  e.preventDefault();
  api.invoke('restore_window', {});
});

// ---- Settings modal ----
const modal = document.getElementById('settings-modal');
async function loadOllamaModels(selected) {
  const sel = document.getElementById('cfg-model');
  const err = document.getElementById('cfg-model-error');
  const url = document.getElementById('cfg-ollamaUrl').value.trim();
  err.textContent = '';
  sel.replaceChildren();
  let models = [];
  try {
    const resp = await fetch(BASE + '/api/models?url=' + encodeURIComponent(url));
    const data = await resp.json();
    models = data.models || [];
    if (data.error) err.textContent = data.error;
  } catch (e) {
    err.textContent = '读取模型失败';
  }
  const names = selected && !models.includes(selected) ? [selected, ...models] : models;
  if (!names.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '没有可用模型';
    sel.appendChild(opt);
    return;
  }
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = names.includes(selected) ? selected : names[0];
}

document.getElementById('settings-btn').addEventListener('click', async () => {
  const cfg = await (await fetch(BASE + '/api/config')).json();
  document.getElementById('cfg-ollamaUrl').value = cfg.ollamaUrl || 'http://127.0.0.1:11434';
  document.getElementById('cfg-breakMinutes').value = cfg.breakMinutes || 30;
  modal.classList.remove('hidden');
  await loadOllamaModels(cfg.model || '');
});
document.getElementById('cfg-ollamaUrl').addEventListener('change', () => {
  loadOllamaModels(document.getElementById('cfg-model').value);
});
document.getElementById('close-cfg').addEventListener('click', () => modal.classList.add('hidden'));
document.getElementById('save-cfg').addEventListener('click', async () => {
  const body = {
    ollamaUrl: document.getElementById('cfg-ollamaUrl').value.trim(),
    model: document.getElementById('cfg-model').value.trim(),
    breakMinutes: Number(document.getElementById('cfg-breakMinutes').value)
  };
  await fetch(BASE + '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  modal.classList.add('hidden');
  addMsg('ai', '配置已保存并即时生效');
});
