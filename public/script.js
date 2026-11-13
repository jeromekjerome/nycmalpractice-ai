// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

// ─── Analytics ───────────────────────────────────────────────────────────────
function track(eventName, params = {}) {
  if (typeof mixpanel !== 'undefined') mixpanel.track(eventName, params);
}

// ─── Session & State ─────────────────────────────────────────────────────────
let sessionId = getCookie('malpractice_session');
if (!sessionId) {
  sessionId = crypto.randomUUID();
  setCookie('malpractice_session', sessionId, 90);
  track('session_start', { app: 'malpractice-ai', mode: 'personal' });
}

let conversationHistory = [];
let currentMode = 'personal';
let isLoading   = false;

// ─── Mode Toggle ─────────────────────────────────────────────────────────────
const modeToggle  = document.getElementById('modeToggle');
const personalLbl = document.getElementById('personalLabel');
const estateLbl   = document.getElementById('estateLabel');

modeToggle.addEventListener('change', async () => {
  currentMode = modeToggle.checked ? 'estate' : 'personal';
  track('mode_toggle', { app: 'malpractice-ai', mode: currentMode });
  document.body.classList.toggle('estate-mode', modeToggle.checked);

  personalLbl.classList.toggle('active', !modeToggle.checked);
  estateLbl.classList.toggle('active', modeToggle.checked);

  // Reset session for new mode
  conversationHistory = [];
  await fetch('/api/reset-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) }).catch(() => {});
  sessionId = crypto.randomUUID();
  setCookie('malpractice_session', sessionId, 90);

  updateModeUI();
  const conv = document.getElementById('conversation');
  conv.innerHTML = '';
  appendMessage('ai', getModeWelcome());

  document.getElementById('analysisCard').style.display = 'none';
  document.getElementById('casesCard').style.display    = 'none';
  document.getElementById('solTitle').textContent = currentMode === 'estate'
    ? 'Wrongful Death SOL'
    : 'NY Statute of Limitations';
  document.getElementById('solText').innerHTML = currentMode === 'estate'
    ? '<strong style="color:var(--text)">Wrongful death:</strong> 2 years from date of death (EPTL §5-4.1)<br><br><strong style="color:var(--text)">Public hospitals:</strong> notice of claim within 90 days after an administrator is appointed<br><br>The action is brought by the estate administrator, not the family directly. Estate appointment may be required first. <em>Act promptly.</em>'
    : '<strong style="color:var(--text)">Personal injury:</strong> 2.5 years from the act or omission, or from the last treatment for the same condition<br><br><strong style="color:var(--text)">Public hospitals:</strong> notice of claim within 90 days; lawsuit within 1 year and 90 days<br><br><strong style="color:var(--text)">Wrongful death:</strong> 2 years from date of death<br><br>Later deadlines: foreign object (1 year from discovery), missed cancer diagnosis (Lavern’s Law, up to 7 years), infancy (no more than 10 years). <em>Act promptly.</em>';
});

function updateModeUI() {
  const isEstate = currentMode === 'estate';
  document.getElementById('heroTitle').textContent   = isEstate ? 'Wrongful Death Malpractice\nfor New York Families' : 'Medical Malpractice Legal AI\nfor New York';
  document.getElementById('heroSubtitle').textContent = isEstate
    ? 'Your loved one deserved better care. Understand your family\'s rights.'
    : 'Understand your rights. Analyze your case. Connect with specialist attorneys.';
  document.getElementById('chatTitle').textContent  = isEstate ? 'Wrongful Death Claim Advisor' : 'Malpractice Case Advisor';
  document.getElementById('inputLabel').textContent = isEstate ? 'Describe what happened to your loved one' : 'Describe your situation';
  document.getElementById('userInput').placeholder  = isEstate
    ? 'Who passed away, when, and what was the alleged medical error?'
    : 'What happened, and when? What provider or facility was involved?';
}

function getModeWelcome() {
  if (currentMode === 'estate') {
    return 'I\'m deeply sorry for your loss. This AI is specialized in New York wrongful death medical malpractice claims.<br><br>When a family member dies due to a healthcare provider\'s negligence, the law provides a path for the estate to seek accountability and compensation — but the statute of limitations is only <strong>2 years from the date of death</strong>.<br><br><strong>To get started</strong> — tell me about your loved one: who they were, what the alleged medical error was, and when they passed away.';
  }
  return 'Welcome. This AI is specialized in New York medical malpractice law. Whether you were personally harmed by a healthcare provider or you\'ve lost a loved one due to medical negligence, I can help you understand your rights and the strength of your potential claim.<br><br><strong>To get started</strong> — tell me what happened. What type of provider was involved, and what injury resulted?';
}

// ─── Submit ───────────────────────────────────────────────────────────────────
async function submitQuestion() {
  const input = document.getElementById('userInput');
  const q     = input.value.trim();
  if (!q || isLoading) return;

  isLoading = true;
  setLoading(true);
  track('chat_message_sent', {
    app: 'malpractice-ai',
    mode: currentMode,
    turn_number: conversationHistory.filter(m => m.role === 'user').length + 1,
  });
  appendMessage('user', q);
  input.value = '';

  const thinking = appendThinking();

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, mode: currentMode, sessionId, history: conversationHistory }),
    });
    const data = await res.json();

    thinking.remove();

    if (data.error) { appendMessage('ai', 'I encountered an error. Please try again.'); return; }

    conversationHistory.push({ role: 'user', content: q });
    conversationHistory.push({ role: 'assistant', content: data.answer });

    appendMessage('ai', markdownToHtml(data.answer));

    if (data.cases?.length) renderCases(data.cases);
    if (data.caseAnalysis)  renderCaseAnalysis(data.caseAnalysis);

  } catch (err) {
    thinking.remove();
    appendMessage('ai', 'Network error — please check your connection and try again.');
  } finally {
    isLoading = false;
    setLoading(false);
  }
}

document.getElementById('userInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitQuestion(); }
});

// ─── Render Helpers ───────────────────────────────────────────────────────────
function appendMessage(role, html) {
  const conv = document.getElementById('conversation');
  const div  = document.createElement('div');
  div.className = `msg msg-${role}`;
  div.innerHTML = html;
  conv.appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return div;
}

function appendThinking() {
  const conv = document.getElementById('conversation');
  const div  = document.createElement('div');
  div.className = 'msg msg-thinking';
  div.innerHTML = '<div class="thinking-spinner"></div><span>Analyzing your situation…</span>';
  conv.appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return div;
}

function renderCases(cases) {
  const card = document.getElementById('casesCard');
  const list = document.getElementById('casesList');
  list.innerHTML = cases.map(c => `
    <div class="case-item">
      <div class="case-name">
        ${c.absoluteUrl ? `<a href="${escHtml(c.absoluteUrl)}" target="_blank" rel="noopener">${escHtml(c.caseName)}</a>` : escHtml(c.caseName)}
      </div>
      <div class="case-meta">${escHtml(c.court || '')}${c.dateFiled ? ' · ' + escHtml(c.dateFiled) : ''}${c.citation ? ' · ' + escHtml(c.citation) : ''}</div>
      ${c.snippet ? `<div class="case-snippet">${escHtml(c.snippet)}</div>` : ''}
    </div>
  `).join('');
  card.style.display = 'block';
}

function renderCaseAnalysis(analysis) {
  track('case_analysis_viewed', { app: 'malpractice-ai', verdict: analysis.verdict, score: analysis.score });
  const card    = document.getElementById('analysisCard');
  const content = document.getElementById('analysisContent');

  const scoreColor = analysis.score >= 7 ? '#4ade80' : analysis.score >= 4 ? '#fbbf24' : '#f87171';
  const barPct     = (analysis.score || 0) * 10;

  const complexityHtml = analysis.complexityEstimate
    ? `<div class="analysis-row">
         <span class="analysis-label">Complexity</span>
         <span class="analysis-val">${escHtml(analysis.complexityEstimate.level || '')}</span>
       </div>
       ${analysis.complexityEstimate.reason ? `<div style="font-size:0.75rem;color:var(--muted);margin-bottom:0.5rem">${escHtml(analysis.complexityEstimate.reason)}</div>` : ''}`
    : '';

  const solWarnHtml = analysis.solWarning
    ? `<div class="factor factor-warn">⏱️ ${escHtml(analysis.solWarning)}</div>`
    : '';

  const strengthsHtml = (analysis.strengths || []).map(s => `<div class="factor factor-pro">✓ ${escHtml(s)}</div>`).join('');
  const weaknessesHtml = (analysis.weaknesses || []).map(w => `<div class="factor factor-con">△ ${escHtml(w)}</div>`).join('');

  content.innerHTML = `
    <div class="score-meter">
      <div class="score-dial">
        <span class="score-number" style="color:${scoreColor}">${analysis.score || '—'}</span>
        <span class="score-label-sm">/10</span>
      </div>
      <span class="verdict-label" style="color:${scoreColor}">${escHtml(analysis.verdict || '')}</span>
    </div>
    <div class="score-bar"><div class="score-bar-fill" style="width:${barPct}%;background:${scoreColor}"></div></div>
    ${complexityHtml}
    <div class="factors-list">
      ${solWarnHtml}
      ${strengthsHtml}
      ${weaknessesHtml}
    </div>
    <div class="analysis-disclaimer">Preliminary analysis only. Consult a qualified NY malpractice attorney.</div>
  `;
  card.style.display = 'block';
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function markdownToHtml(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hul])/gm, '')
    .replace(/\n/g, '<br>');
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setLoading(on) {
  document.getElementById('submitBtn').disabled    = on;
  document.getElementById('btnText').style.display = on ? 'none' : '';
  document.getElementById('btnSpinner').style.display = on ? 'block' : 'none';
}

function setCookie(name, value, days) {
  const exp = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${value};expires=${exp};path=/;SameSite=Lax`;
}

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? match[1] : null;
}

// ─── Restore session ──────────────────────────────────────────────────────────
(async () => {
  try {
    const res  = await fetch(`/api/conversations/${sessionId}`);
    const data = await res.json();
    if (!data.history?.length) return;

    conversationHistory = data.history;
    currentMode = data.mode || 'personal';

    if (currentMode === 'estate') {
      modeToggle.checked = true;
      document.body.classList.add('estate-mode');
      personalLbl.classList.remove('active');
      estateLbl.classList.add('active');
      updateModeUI();
    }

    const conv = document.getElementById('conversation');
    conv.innerHTML = '';
    for (const msg of data.history) {
      const div = document.createElement('div');
      div.className = `msg msg-${msg.role === 'user' ? 'user' : 'ai'}`;
      div.innerHTML = msg.role === 'user' ? escHtml(msg.content) : markdownToHtml(msg.content);
      conv.appendChild(div);
    }
    conv.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
  } catch {}
})();

// ─── Load case types ──────────────────────────────────────────────────────────
(async () => {
  try {
    const res  = await fetch('/api/case-types');
    const data = await res.json();
    if (!data.caseTypes?.length) return;
    const list = document.getElementById('caseTypesList');
    list.innerHTML = data.caseTypes.map(t => `<li>${escHtml(t)}</li>`).join('');
  } catch {}
})();
