const timersEl = document.getElementById('timers');
const chatBox = document.getElementById('chat-box');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');

// 桌面窗口从本地文件加载时，API 在 localhost:3000；浏览器直接访问则用相对路径
const BASE = /(^https?:\/\/[^/]*):3000/.test(window.location.href) ? '' : 'http://localhost:3000';


const ui = {
  alarmSound: 'kitchen', alarmVolume: 70, alarmRepeat: 1,
  focusSound: 'soft', focusVolume: 50,
  theme: 'red', hourFormat: '24', darkWhenRunning: false
};

function fmt(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  if (h <= 0) return mm + ':' + ss;
  const hour = ui.hourFormat === '12' ? (h % 12 || 12) : h;
  return String(hour).padStart(2, '0') + ':' + mm + ':' + ss;
}

function escAttr(s) { return s.replace(/"/g, '&quot;'); }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTimers(timers) {
  if (!timers.length) {
    timersEl.innerHTML = '<div class="empty">还没有计时器，在下方对话里告诉 AI 添加一个</div>';
    document.body.classList.remove('running-dark');
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
  document.body.classList.toggle('running-dark', ui.darkWhenRunning && timers.some(t => t.running));
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
  if (btn.dataset.act === 'start') unlockAudio();
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
let heardTimers = false;
const TONES = {
  soft: { type: 'sine', freqs: [784], dur: 0.16 },
  bell: { type: 'sine', freqs: [988, 1319], dur: 0.22 },
  digital: { type: 'square', freqs: [880], dur: 0.1 },
  chime: { type: 'triangle', freqs: [523, 659, 784], dur: 0.16 },
  kitchen: { type: 'triangle', freqs: [880, 1175], dur: 0.2 }
};

function unlockAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
document.addEventListener('pointerdown', unlockAudio);

function playTone(name, volume, repeat) {
  const spec = TONES[name];
  if (!spec) return;
  unlockAudio();
  if (!audioCtx) return;
  const vol = Math.max(0.001, Math.min(1, Number(volume) / 100));
  const times = Math.max(1, Math.min(10, repeat || 1));
  const run = () => {
    const gap = spec.freqs.length * (spec.dur + 0.04) + 0.18;
    for (let n = 0; n < times; n++) {
      spec.freqs.forEach((freq, i) => {
        const now = audioCtx.currentTime + n * gap + i * (spec.dur + 0.03);
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = spec.type;
        o.frequency.value = freq;
        o.connect(g);
        g.connect(audioCtx.destination);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(vol, now + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, now + spec.dur);
        o.start(now);
        o.stop(now + spec.dur + 0.02);
      });
    }
  };
  if (audioCtx.state === 'suspended') audioCtx.resume().then(run).catch(() => {});
  else run();
}

function noteSounds(timers) {
  const nowRunning = new Set();
  let started = false;
  let finished = false;
  for (const t of timers) {
    if (t.running) {
      nowRunning.add(t.id);
      if (heardTimers && !seenRunning.has(t.id)) started = true;
    } else if (seenRunning.has(t.id) && t.remaining <= 0) finished = true;
  }
  heardTimers = true;
  seenRunning = nowRunning;
  if (started) playTone(ui.focusSound, ui.focusVolume, 1);
  if (finished) playTone(ui.alarmSound, ui.alarmVolume, ui.alarmRepeat);
}

function connectSSE() {
  const es = new EventSource(BASE + '/api/events');
  es.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'timers') {
        noteSounds(d.timers);
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

function fillUiForm() {
  document.getElementById('cfg-alarmSound').value = ui.alarmSound;
  document.getElementById('cfg-alarmVolume').value = ui.alarmVolume;
  document.getElementById('cfg-alarmRepeat').value = ui.alarmRepeat;
  document.getElementById('cfg-focusSound').value = ui.focusSound;
  document.getElementById('cfg-focusVolume').value = ui.focusVolume;
  document.getElementById('cfg-hourFormat').value = ui.hourFormat;
  document.getElementById('cfg-darkWhenRunning').checked = ui.darkWhenRunning;
  document.querySelectorAll('#cfg-theme .swatch').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.theme === ui.theme);
  });
}
function readUiForm() {
  const themeBtn = document.querySelector('#cfg-theme .swatch.on');
  return {
    alarmSound: document.getElementById('cfg-alarmSound').value,
    alarmVolume: Number(document.getElementById('cfg-alarmVolume').value),
    alarmRepeat: Number(document.getElementById('cfg-alarmRepeat').value),
    focusSound: document.getElementById('cfg-focusSound').value,
    focusVolume: Number(document.getElementById('cfg-focusVolume').value),
    theme: themeBtn ? themeBtn.dataset.theme : 'red',
    hourFormat: document.getElementById('cfg-hourFormat').value,
    darkWhenRunning: document.getElementById('cfg-darkWhenRunning').checked
  };
}
function applyUi(next) {
  Object.assign(ui, next);
  document.documentElement.dataset.theme = ui.theme;
  const running = document.querySelector('.timer-card.running');
  document.body.classList.toggle('running-dark', ui.darkWhenRunning && !!running);
}
function takeConfig(cfg) {
  const next = {};
  for (const k of Object.keys(ui)) if (cfg[k] != null) next[k] = cfg[k];
  applyUi(next);
}

document.getElementById('cfg-alarmSound').addEventListener('change', e => {
  playTone(e.target.value, document.getElementById('cfg-alarmVolume').value, 1);
});
document.getElementById('cfg-focusSound').addEventListener('change', e => {
  playTone(e.target.value, document.getElementById('cfg-focusVolume').value, 1);
});
document.getElementById('cfg-theme').addEventListener('click', e => {
  const btn = e.target.closest('.swatch');
  if (!btn) return;
  document.querySelectorAll('#cfg-theme .swatch').forEach(el => el.classList.toggle('on', el === btn));
  document.documentElement.dataset.theme = btn.dataset.theme;
});
document.getElementById('cfg-small').addEventListener('click', () => {
  const api = window.__TAURI_INTERNALS__;
  if (!api) return;
  modal.classList.add('hidden');
  api.invoke('compact_window');
});

document.getElementById('settings-btn').addEventListener('click', async () => {
  unlockAudio();
  const cfg = await (await fetch(BASE + '/api/config')).json();
  takeConfig(cfg);
  fillUiForm();
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
  const body = Object.assign({
    ollamaUrl: document.getElementById('cfg-ollamaUrl').value.trim(),
    model: document.getElementById('cfg-model').value.trim(),
    breakMinutes: Number(document.getElementById('cfg-breakMinutes').value)
  }, readUiForm());
  await fetch(BASE + '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  applyUi(readUiForm());
  modal.classList.add('hidden');
  addMsg('ai', '配置已保存并即时生效');
});

fetch(BASE + '/api/config').then(r => r.json()).then(takeConfig).catch(() => {});

const reportModal = document.getElementById('report-modal');
let reportRange = 'week';
let reportOffset = 0;

function paintReport(data) {
  document.getElementById('stat-hours').textContent = data.hours;
  document.getElementById('stat-days').textContent = data.days;
  document.getElementById('stat-streak').textContent = data.streak;
  document.getElementById('report-title').textContent = data.title;
  document.getElementById('report-next').disabled = reportOffset >= 0;
  const max = Math.max(...data.buckets.map(b => b.hours), 0);
  document.getElementById('report-chart').innerHTML = data.buckets.map(b => {
    const h = max ? Math.max(4, Math.round(b.hours / max * 120)) : 0;
    return '<div class="bar-col"><div class="bar" style="height:' + (b.hours ? h : 0) + 'px"></div><em>' + b.label + '</em></div>';
  }).join('');
  const detail = document.querySelector('[data-panel="detail"]');
  detail.innerHTML = data.detail.length
    ? '<div class="report-list">' + data.detail.map(e => {
      const when = new Date(e.at);
      const label = (when.getMonth() + 1) + '/' + when.getDate() + ' ' + String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0');
      return '<div><b>' + escapeHtml(e.name) + '</b><span>' + e.minutes + ' 分钟 · ' + label + '</span></div>';
    }).join('') + '</div>'
    : '<div class="empty">还没有完成的计时</div>';
}

async function loadReport() {
  const resp = await fetch(BASE + '/api/report?range=' + reportRange + '&offset=' + reportOffset);
  paintReport(await resp.json());
}

document.getElementById('report-btn').addEventListener('click', () => {
  reportModal.classList.remove('hidden');
  loadReport().catch(() => {});
});
document.getElementById('report-close').addEventListener('click', () => reportModal.classList.add('hidden'));
document.getElementById('report-tabs').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#report-tabs button').forEach(el => el.classList.toggle('on', el === btn));
  document.querySelectorAll('#report-modal [data-panel]').forEach(el => {
    el.classList.toggle('hidden', el.dataset.panel !== btn.dataset.tab);
  });
});
document.getElementById('report-range').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  reportRange = btn.dataset.range;
  reportOffset = 0;
  document.querySelectorAll('#report-range button').forEach(el => el.classList.toggle('on', el === btn));
  loadReport().catch(() => {});
});
document.getElementById('report-prev').addEventListener('click', () => { reportOffset--; loadReport().catch(() => {}); });
document.getElementById('report-next').addEventListener('click', () => {
  if (reportOffset >= 0) return;
  reportOffset++;
  loadReport().catch(() => {});
});
