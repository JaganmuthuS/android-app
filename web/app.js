'use strict';

/* ---------- storage ---------- */
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('jarvis.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('jarvis.' + key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

/* ---------- AI providers ---------- */
const PROVIDERS = {
  pollinations: { label: 'Pollinations — free, no key', needsKey: false, model: 'openai' },
  gemini: { label: 'Google Gemini — free key', needsKey: true, model: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey' },
  groq: { label: 'Groq — free key', needsKey: true, model: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys', url: 'https://api.groq.com/openai/v1/chat/completions' },
  openrouter: { label: 'OpenRouter — free models', needsKey: true, model: 'meta-llama/llama-3.3-70b-instruct:free', keyUrl: 'https://openrouter.ai/keys', url: 'https://openrouter.ai/api/v1/chat/completions' },
};
const shortName = (id) => PROVIDERS[id].label.split(' —')[0];

let settings = Object.assign(
  { provider: 'pollinations', keys: {}, models: {}, voice: true, handsFree: false, name: '' },
  store.get('settings', {})
);
if (!PROVIDERS[settings.provider]) settings.provider = 'pollinations';
let messages = store.get('history', []);
let notes = store.get('notes', []);
let reminders = store.get('reminders', []);

const modelFor = (id) => (settings.models[id] || '').trim() || PROVIDERS[id].model;
const usable = (id) => !PROVIDERS[id].needsKey || !!(settings.keys[id] || '').trim();

function systemPrompt() {
  const who = settings.name.trim() ? `Address the user as ${settings.name.trim()}.` : "Address the user as 'sir' or 'ma'am' sparingly.";
  const now = new Date().toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
  let p = 'You are J.A.R.V.I.S. (version 1.0), a witty, loyal and highly capable personal AI assistant on the user\'s iPhone. ' +
    'Be helpful, accurate and concise, like a polite British butler with dry humour. ' + who + ' ' +
    `The current date and time is ${now}. ` +
    'Use Markdown (bold, lists, code blocks) only when it genuinely helps; replies may be read aloud, so keep them short unless asked for detail.';
  if (notes.length) {
    p += '\n\nThings the user asked you to remember (use them when relevant):\n' +
      notes.map((n) => `- ${n.text} (saved ${new Date(n.at).toLocaleDateString()})`).join('\n');
  }
  return p;
}

async function http(url, options, ms = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'timed out' : 'network error');
  } finally {
    clearTimeout(timer);
  }
}

async function errorText(res) {
  const body = await res.text().catch(() => '');
  try {
    const j = JSON.parse(body);
    const e = j.error;
    return `${res.status}: ${(typeof e === 'string' ? e : e?.message) || body}`.slice(0, 200);
  } catch { return `${res.status}: ${body}`.slice(0, 200); }
}

async function openAiCompatible(url, key, model, history) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  const res = await http(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt() }, ...history.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))],
    }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  const text = (await res.json())?.choices?.[0]?.message?.content;
  if (!text || !text.trim()) throw new Error('empty reply');
  return text.trim();
}

const callers = {
  async pollinations(history) {
    try {
      return await openAiCompatible('https://text.pollinations.ai/openai', '', modelFor('pollinations'), history);
    } catch (first) {
      // Simpler GET endpoint as a second chance (only carries the last question).
      const q = [...history].reverse().find((m) => m.role === 'user')?.text;
      if (!q) throw first;
      const url = 'https://text.pollinations.ai/' + encodeURIComponent(q) +
        '?model=' + encodeURIComponent(modelFor('pollinations')) + '&system=' + encodeURIComponent(systemPrompt());
      const res = await http(url, {});
      if (!res.ok) throw new Error(await errorText(res));
      const text = (await res.text()).trim();
      if (!text) throw first;
      return text;
    }
  },
  async gemini(history) {
    const model = modelFor('gemini');
    const res = await http(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.keys.gemini.trim() },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt() }] },
        contents: history.map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] })),
      }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    const parts = (await res.json())?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || '').join('').trim();
    if (!text) throw new Error('empty reply');
    return text;
  },
  groq: (h) => openAiCompatible(PROVIDERS.groq.url, settings.keys.groq.trim(), modelFor('groq'), h),
  openrouter: (h) => openAiCompatible(PROVIDERS.openrouter.url, settings.keys.openrouter.trim(), modelFor('openrouter'), h),
};

/** Ask the chosen brain; if it fails, fall back to every other brain that is set up. */
async function askAI(history) {
  const order = [settings.provider, ...Object.keys(PROVIDERS).filter((p) => p !== settings.provider)].filter(usable);
  const failures = [];
  for (const id of order) {
    try {
      return { text: await callers[id](history), via: id };
    } catch (e) {
      failures.push(`${shortName(id)} (${e.message})`);
    }
  }
  let msg = 'All my AI services are unavailable right now: ' + failures.join('; ') + '.';
  if (!PROVIDERS[settings.provider].needsKey && order.length < 2) {
    msg += ' The free no-key service allows about one question every 15 seconds. For a steadier connection, add a free Gemini key in ⚙︎ Settings.';
  }
  if (!usable(settings.provider)) msg = `${shortName(settings.provider)} needs an API key — add it in ⚙︎ Settings. ` + msg;
  throw new Error(msg);
}

/* ---------- Markdown (safe subset) ---------- */
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(s) {
  return s.split(/(`[^`\n]+`)/g).map((part, i) => {
    if (i % 2) return `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  }).join('');
}

function blocks(text) {
  let html = '';
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { html += `<p>${para.map(inline).join('<br>')}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`; list = null; } };
  for (const line of text.split('\n')) {
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const h = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((ul || ol)[1]);
    } else if (h) {
      flushPara(); flushList();
      html += `<p class="h">${inline(h[1])}</p>`;
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return html;
}

function markdown(src) {
  const parts = src.split(/```[\w+-]*\n?([\s\S]*?)```/g);
  return parts.map((p, i) => (i % 2 ? `<pre><code>${esc(p.replace(/\n$/, ''))}</code></pre>` : blocks(p))).join('');
}

function plainForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' The code is on screen. ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/[*_#`>|~]/g, '')
    .replace(/^\s*[-•]\s+/gm, '');
}

/* ---------- reminders ---------- */
function parseWhen(spec) {
  spec = spec.toLowerCase().trim().replace(/[.!?]$/, '');
  const now = new Date();
  const rel = spec.match(/^(?:in\s+)?(\d+|an?|half an?)\s*(minutes?|mins?|hours?|hrs?|days?)$/);
  if (rel) {
    const n = /^half/.test(rel[1]) ? 0.5 : /^an?$/.test(rel[1]) ? 1 : parseInt(rel[1], 10);
    const unit = rel[2][0] === 'm' ? 60e3 : rel[2][0] === 'h' ? 3600e3 : 86400e3;
    return new Date(now.getTime() + n * unit);
  }
  let day = 0;
  if (/\btomorrow\b/.test(spec)) day = 1;
  spec = spec.replace(/\b(today|tonight|tomorrow|at|on|this)\b/g, ' ').trim();
  let h, m = 0;
  if (/^noon$|^midday$/.test(spec)) h = 12;
  else if (/^midnight$/.test(spec)) { h = 0; if (!day) day = 1; }
  else {
    const t = spec.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|morning|evening|night)?$/);
    if (!t) return null;
    h = parseInt(t[1], 10); m = t[2] ? parseInt(t[2], 10) : 0;
    const ap = t[3] || '';
    if (/^p|evening|night/.test(ap) && h < 12) h += 12;
    if (/^a|morning/.test(ap) && h === 12) h = 0;
    if (!ap && !t[2] && h < 7) h += 12; // "remind me at 5" most likely means 5 pm
    if (h > 23 || m > 59) return null;
  }
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, h, m);
  if (!day && d <= now) d.setDate(d.getDate() + 1);
  return d;
}

function parseReminder(text) {
  const t = text.replace(/^(please\s+)?/i, '').trim();
  let m;
  if ((m = t.match(/^remind me (in .+?|at .+?|tomorrow(?: at)? .+?|tonight at .+?) to (.+)$/i))) return { when: m[1], what: m[2] };
  if ((m = t.match(/^remind me (?:to |about )?(.+?) (in \d+ \w+|in an? \w+|in half an? \w+|(?:tomorrow |today |tonight )?(?:at )?\d{1,2}(?:[:.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|(?:tomorrow |tonight )?at (?:noon|midnight)|tomorrow)$/i))) {
    return { when: m[2], what: m[1] };
  }
  return null;
}

function icsDate(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function reminderLinks(r) {
  const start = new Date(r.at);
  const end = new Date(start.getTime() + 15 * 60e3);
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jarvis//1.0//EN', 'BEGIN:VEVENT',
    `UID:${r.id}@jarvis`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${r.what.replace(/[,;\\]/g, (c) => '\\' + c)}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${r.what.replace(/[,;\\]/g, (c) => '\\' + c)}`, 'TRIGGER:-PT0M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const google = 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(r.what) +
    '&dates=' + icsDate(start) + '/' + icsDate(end);
  return [
    { label: '📅 Add to iPhone Calendar', href: 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics) },
    { label: 'Google Calendar', href: google },
  ];
}

const fmtWhen = (d) => d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });

function checkReminders() {
  const now = Date.now();
  let changed = false;
  for (const r of reminders) {
    if (!r.done && r.at <= now) {
      r.done = true; changed = true;
      reply(`⏰ Reminder: **${r.what}**`);
    }
  }
  if (changed) { reminders = reminders.filter((r) => !r.done || now - r.at < 86400e3); store.set('reminders', reminders); }
}

/* ---------- local commands (no AI needed) ---------- */
const APP_LINKS = {
  whatsapp: 'whatsapp://', youtube: 'youtube://', instagram: 'instagram://', spotify: 'spotify://',
  facebook: 'fb://', messenger: 'fb-messenger://', telegram: 'tg://', twitter: 'twitter://', x: 'twitter://',
  gmail: 'googlegmail://', 'google maps': 'comgooglemaps://', maps: 'maps://', netflix: 'nflx://',
  snapchat: 'snapchat://', linkedin: 'linkedin://', uber: 'uber://', zoom: 'zoomus://', chrome: 'googlechrome://',
  music: 'music://', 'apple music': 'music://', podcasts: 'podcasts://', mail: 'message://', phone: 'tel://',
  messages: 'sms://', facetime: 'facetime://', shortcuts: 'shortcuts://', calendar: 'calshow://', photos: 'photos-redirect://',
  'app store': 'itms-apps://', settings: 'App-prefs:', notes: 'mobilenotes://', reminders: 'x-apple-reminderkit://',
};

function localCommand(input) {
  const raw = input.trim().replace(/^(hey |ok )?jarvis[,!.]?\s*/i, '').replace(/[.!?]+$/, '');
  const t = raw.toLowerCase();
  let m;

  if (/^((what('?s| is) the )?time( is it)?|what time is it|tell me the time)( now| right now)?$/.test(t)) {
    return { text: `It is ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.` };
  }
  if (/^(what('?s| is) )?(today'?s )?(the )?date( today)?$|^what day is (it|today)$/.test(t)) {
    return { text: `Today is ${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.` };
  }

  // Memory
  if ((m = raw.match(/^(?:please )?(?:remember|note|don'?t forget)(?: that)?[:,]?\s+(.+)$/i)) && !/^to remind/i.test(m[1])) {
    notes.push({ text: m[1], at: Date.now() });
    store.set('notes', notes);
    return { text: `Noted. I'll remember that ${m[1].replace(/^my /i, 'your ').replace(/^i /i, 'you ')}.` };
  }
  if (/^(what do you remember|what have you remembered|(show |list )?(my )?(notes|memories|memory))( about me)?$/.test(t)) {
    return { text: notes.length ? 'Here is what I remember:\n' + notes.map((n) => `- ${n.text}`).join('\n') : "I haven't been asked to remember anything yet. Say \"remember …\" and I will." };
  }
  if (/^(forget everything|clear (my )?(notes|memory|memories))$/.test(t)) {
    notes = []; store.set('notes', notes);
    return { text: 'Done. My memory is wiped clean.' };
  }
  if ((m = raw.match(/^forget (?:about |that )?(.+)$/i))) {
    const key = m[1].toLowerCase();
    const before = notes.length;
    notes = notes.filter((n) => !n.text.toLowerCase().includes(key));
    store.set('notes', notes);
    return { text: before === notes.length ? `I don't have anything saved about "${m[1]}".` : `Forgotten. I no longer remember anything about "${m[1]}".` };
  }

  // Reminders
  if (/^(show |list |what are )?(my )?reminders$/.test(t)) {
    const open = reminders.filter((r) => !r.done).sort((a, b) => a.at - b.at);
    return { text: open.length ? 'Your reminders:\n' + open.map((r) => `- ${fmtWhen(new Date(r.at))}: ${r.what}`).join('\n') : 'You have no reminders set.' };
  }
  if (/^remind me\b/i.test(raw)) {
    const p = parseReminder(raw);
    const when = p && parseWhen(p.when);
    if (!p || !when) {
      return { text: 'Tell me what and when, for example: "remind me at 6 pm to buy milk" or "remind me to call Mom in 20 minutes".' };
    }
    const r = { id: Date.now().toString(36), what: p.what.replace(/^to /i, ''), at: when.getTime(), done: false };
    reminders.push(r); store.set('reminders', reminders);
    return {
      text: `Reminder set for **${fmtWhen(when)}**: ${r.what}.\n\nTap below to add it to your Calendar, so your iPhone alerts you even when Jarvis is closed.`,
      chips: reminderLinks(r),
    };
  }

  // Phone actions
  if ((m = t.match(/^(?:call|dial|phone) ([+\d][\d\s()-]{2,})$/))) {
    const n = m[1].replace(/[^\d+]/g, '');
    return { text: `Calling ${n}.`, open: 'tel:' + n, chips: [{ label: `📞 Call ${n}`, href: 'tel:' + n }] };
  }
  if ((m = raw.match(/^(?:text|message|sms|send (?:a )?(?:text|message|sms) to) ([+\d][\d\s()-]{2,}?)(?: saying| that|:)\s*(.+)$/i))) {
    const n = m[1].replace(/[^\d+]/g, '');
    const href = `sms:${n}&body=${encodeURIComponent(m[2])}`;
    return { text: `Message to ${n} ready: "${m[2]}". Tap send in Messages.`, open: href, chips: [{ label: '💬 Open message', href }] };
  }
  if ((m = raw.match(/^whatsapp ([+\d][\d\s()-]{2,}?)(?: saying| that|:)\s*(.+)$/i))) {
    const n = m[1].replace(/[^\d]/g, '');
    const href = `https://wa.me/${n}?text=${encodeURIComponent(m[2])}`;
    return { text: `WhatsApp message to ${n} ready.`, open: href, chips: [{ label: '🟢 Open WhatsApp', href }] };
  }
  if ((m = raw.match(/^play (.+) on youtube$/i))) {
    const href = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(m[1]);
    return { text: `Searching YouTube for ${m[1]}.`, open: href, chips: [{ label: '▶︎ Open YouTube', href }] };
  }
  if ((m = raw.match(/^(?:search(?: for| the web for)?|google|look up) (.+)$/i))) {
    const href = 'https://www.google.com/search?q=' + encodeURIComponent(m[1]);
    return { text: `Searching the web for ${m[1]}.`, open: href, chips: [{ label: '🔎 Open results', href }] };
  }
  if ((m = raw.match(/^(?:navigate|directions|take me|drive) to (.+)$/i))) {
    const href = 'https://maps.apple.com/?daddr=' + encodeURIComponent(m[1]);
    return { text: `Getting directions to ${m[1]}.`, open: href, chips: [{ label: '🧭 Open Maps', href }] };
  }
  if ((m = t.match(/^(?:open|launch|start) (.+?)(?: app)?$/))) {
    const name = m[1].trim();
    if (APP_LINKS[name]) {
      return { text: `Opening ${name}.`, open: APP_LINKS[name], chips: [{ label: `Open ${name}`, href: APP_LINKS[name] }] };
    }
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(name)) {
      return { text: `Opening ${name}.`, open: 'https://' + name, chips: [{ label: `Open ${name}`, href: 'https://' + name }] };
    }
  }
  return null;
}

/* ---------- speech ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let voice = null;
let recognition = null;
let speechUnlocked = false;

function pickVoice() {
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  voice = vs.find((v) => /daniel/i.test(v.name) && /en-GB/i.test(v.lang)) ||
    vs.find((v) => /en-GB/i.test(v.lang)) ||
    vs.find((v) => v.lang && v.lang.startsWith((navigator.language || 'en').slice(0, 2))) || null;
}
if (window.speechSynthesis) {
  pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
}

// iOS only lets a page speak after the user has tapped something once.
function unlockSpeech() {
  if (speechUnlocked || !window.speechSynthesis) return;
  speechUnlocked = true;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

function speak(text, then) {
  if (!settings.voice || !window.speechSynthesis) { then && then(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(plainForSpeech(text));
  if (voice) { u.voice = voice; u.lang = voice.lang; }
  u.rate = 1.02; u.pitch = 0.9;
  setReactor('speaking');
  let finished = false;
  const done = () => { if (finished) return; finished = true; setReactor(''); then && then(); };
  u.onend = done;
  u.onerror = done;
  speechSynthesis.speak(u);
}

function stopSpeaking() {
  if (window.speechSynthesis) speechSynthesis.cancel();
  setReactor('');
}

function listen() {
  if (recognition) { recognition.stop(); return; }
  if (!SR) {
    toastBot('Voice input isn\'t available in this browser mode. Tap the text box and use the 🎤 key on your iPhone keyboard to dictate.');
    return;
  }
  stopSpeaking();
  const rec = new SR();
  recognition = rec;
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    finalText = '';
    for (const r of e.results) (r.isFinal ? (finalText += r[0].transcript) : (interim += r[0].transcript));
    input.value = (finalText || interim).trim();
    syncComposer();
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      settings.handsFree = false; saveSettings();
      toastBot('I need microphone and speech recognition permission. On iPhone: Settings → Safari (or Settings → Privacy & Security → Microphone / Speech Recognition).');
    }
  };
  rec.onend = () => {
    recognition = null;
    micBtn.classList.remove('live');
    setReactor('');
    const said = (finalText || input.value).trim();
    if (said) { input.value = ''; syncComposer(); send(said); }
  };
  micBtn.classList.add('live');
  setReactor('listening');
  try { rec.start(); } catch { recognition = null; micBtn.classList.remove('live'); setReactor(''); }
}

/* ---------- UI ---------- */
const $ = (s) => document.querySelector(s);
const chat = $('#chat');
const input = $('#input');
const micBtn = $('#btnMic');
const sendBtn = $('#btnSend');
let busy = false;

function setReactor(state) {
  $('#reactor').className = 'reactor' + (state ? ' ' + state : '') + (busy && !state ? ' thinking' : '');
}

function greeting() {
  const n = settings.name.trim() || 'sir';
  return `Good day, ${n}. **J.A.R.V.I.S. 1.0** online and at your service.\n\nAsk me anything, or try:\n- "remind me at 6 pm to buy milk"\n- "remember my car is parked on level B2"\n- "call 9876543210"\n- "navigate to the airport"\n\nTap 🎧 for hands-free conversation.`;
}

function render(m) {
  const el = document.createElement('div');
  el.className = 'msg ' + (m.role === 'user' ? 'user' : 'bot') + (m.err ? ' error' : '');
  if (m.role === 'user') {
    el.textContent = m.text;
  } else {
    el.innerHTML = markdown(m.text);
    for (const c of m.chips || []) {
      const a = document.createElement('a');
      a.className = 'chip';
      a.href = c.href;
      a.textContent = c.label;
      if (/^https?:/.test(c.href)) { a.target = '_blank'; a.rel = 'noopener'; }
      el.appendChild(a);
      el.appendChild(document.createTextNode(' '));
    }
    const tools = document.createElement('div');
    tools.className = 'tools';
    const copy = document.createElement('button');
    copy.textContent = '⧉ Copy';
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(m.text); copy.textContent = '✓ Copied'; } catch { copy.textContent = 'Copy failed'; }
      setTimeout(() => { copy.textContent = '⧉ Copy'; }, 1500);
    };
    const say = document.createElement('button');
    say.textContent = '🔊 Speak';
    say.onclick = () => { unlockSpeech(); const v = settings.voice; settings.voice = true; speak(m.text); settings.voice = v; };
    tools.append(copy, say);
    if (m.via) {
      const via = document.createElement('span');
      via.className = 'via';
      via.textContent = 'via ' + shortName(m.via);
      tools.appendChild(via);
    }
    el.appendChild(tools);
  }
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

function renderAll() {
  chat.innerHTML = '';
  if (!messages.length) messages.push({ role: 'bot', text: greeting() });
  messages.forEach(render);
}

function save() { store.set('history', messages.slice(-200)); }

function add(m) { messages.push(m); render(m); save(); }

function toastBot(text) { add({ role: 'bot', text, err: true }); }

function reply(text, extra = {}) {
  const m = { role: 'bot', text, ...extra };
  add(m);
  speak(text, () => {
    if (settings.handsFree && !document.hidden && !m.err) setTimeout(listen, 250);
  });
}

function setBusy(b) {
  busy = b;
  setReactor('');
  const existing = $('#typing');
  if (b && !existing) {
    const el = document.createElement('div');
    el.id = 'typing'; el.className = 'typing'; el.textContent = 'Thinking…';
    chat.appendChild(el); chat.scrollTop = chat.scrollHeight;
  } else if (!b && existing) existing.remove();
}

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  unlockSpeech();
  stopSpeaking();
  if (/^(clear( chat)?|reset|new chat)$/i.test(text)) { clearChat(); return; }
  add({ role: 'user', text });

  const local = localCommand(text);
  if (local) {
    if (local.open) {
      // Works when triggered by a tap; otherwise the button in the reply does the job.
      setTimeout(() => {
        if (/^https?:/.test(local.open)) window.open(local.open, '_blank', 'noopener');
        else location.href = local.open;
      }, 300);
    }
    reply(local.text, { chips: local.chips });
    return;
  }

  setBusy(true);
  const history = messages.filter((m) => !m.err).slice(-20);
  try {
    const { text: answer, via } = await askAI(history);
    setBusy(false);
    reply(answer, { via });
  } catch (e) {
    setBusy(false);
    add({ role: 'bot', text: '⚠️ ' + e.message, err: true });
  }
}

function clearChat() {
  stopSpeaking();
  messages = [];
  save();
  renderAll();
}

function syncComposer() {
  const has = input.value.trim().length > 0;
  sendBtn.hidden = !has;
  micBtn.hidden = has;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
}

function syncHeader() {
  $('#sub').textContent = `v1.0 · ${shortName(settings.provider)}`;
  $('#btnVoice').textContent = settings.voice ? '🔊' : '🔇';
  $('#btnHands').classList.toggle('off', !settings.handsFree);
}

function saveSettings() { store.set('settings', settings); syncHeader(); }

/* ---------- settings dialog ---------- */
const dlg = $('#settings');
let draft = null;

function fillProviderFields() {
  const p = PROVIDERS[draft.provider];
  $('#keyRow').hidden = !p.needsKey;
  $('#apiKey').value = draft.keys[draft.provider] || '';
  $('#keyLink').href = p.keyUrl || '#';
  $('#model').value = draft.models[draft.provider] || '';
  $('#model').placeholder = p.model;
}

function openSettings() {
  draft = JSON.parse(JSON.stringify(settings));
  const list = $('#providerList');
  list.innerHTML = '';
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const label = document.createElement('label');
    label.className = 'radio switch';
    const r = document.createElement('input');
    r.type = 'radio'; r.name = 'provider'; r.value = id; r.checked = id === draft.provider;
    r.onchange = () => { stash(); draft.provider = id; fillProviderFields(); };
    label.append(r, document.createTextNode(' ' + p.label));
    list.appendChild(label);
  }
  fillProviderFields();
  $('#userName').value = draft.name;
  $('#optVoice').checked = draft.voice;
  $('#optHands').checked = draft.handsFree;
  const nl = $('#notesList');
  nl.innerHTML = '';
  for (const n of notes) { const li = document.createElement('li'); li.textContent = n.text; nl.appendChild(li); }
  dlg.showModal();
}

function stash() {
  draft.keys[draft.provider] = $('#apiKey').value.trim();
  draft.models[draft.provider] = $('#model').value.trim();
}

dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save' || !draft) return;
  stash();
  draft.name = $('#userName').value.trim();
  draft.voice = $('#optVoice').checked;
  draft.handsFree = $('#optHands').checked;
  settings = draft;
  saveSettings();
  if (!settings.voice) stopSpeaking();
});

$('#btnForget').onclick = () => {
  if (!confirm('Forget all saved notes and reminders?')) return;
  notes = []; reminders = [];
  store.set('notes', notes); store.set('reminders', reminders);
  $('#notesList').innerHTML = '';
};

/* ---------- wiring ---------- */
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = '';
  syncComposer();
  send(text);
});
input.addEventListener('input', syncComposer);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});
micBtn.onclick = () => { unlockSpeech(); listen(); };
$('#btnSettings').onclick = openSettings;
$('#btnClear').onclick = clearChat;
$('#btnVoice').onclick = () => { settings.voice = !settings.voice; if (!settings.voice) stopSpeaking(); saveSettings(); };
$('#btnHands').onclick = () => {
  unlockSpeech();
  settings.handsFree = !settings.handsFree;
  saveSettings();
  if (settings.handsFree) {
    if (!SR) { toastBot('Hands-free needs speech recognition, which this browser mode doesn\'t offer. You can still dictate with the keyboard 🎤.'); return; }
    listen();
  } else if (recognition) recognition.stop();
};
document.addEventListener('visibilitychange', () => { if (document.hidden && recognition) recognition.stop(); });

// "Add to Home Screen" hint for iPhone Safari.
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
if (isIOS && !standalone && !store.get('installDismissed', false)) $('#install').hidden = false;
$('#installClose').onclick = () => { $('#install').hidden = true; store.set('installDismissed', true); };

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

syncHeader();
syncComposer();
renderAll();
checkReminders();
setInterval(checkReminders, 20000);
