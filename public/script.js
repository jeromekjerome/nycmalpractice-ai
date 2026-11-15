// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

// ─── Analytics ───────────────────────────────────────────────────────────────
function track(eventName, params = {}) {
  if (typeof mixpanel !== 'undefined') mixpanel.track(eventName, params);
}

// ─── Session & State ─────────────────────────────────────────────────────────
const lastSessionId = getCookie('malpractice_session');
const isNewSession = !lastSessionId;
const sessionIds = {
  personal: getCookie('malpractice_personal_session') || lastSessionId || crypto.randomUUID(),
  estate: getCookie('malpractice_estate_session') || crypto.randomUUID(),
};
const initialMode = lastSessionId === sessionIds.estate ? 'estate' : 'personal';
let sessionId = sessionIds[initialMode];
setCookie('malpractice_personal_session', sessionIds.personal, 90);
setCookie('malpractice_estate_session', sessionIds.estate, 90);
setCookie('malpractice_session', sessionId, 90);
if (isNewSession) track('session_start', { app: 'malpractice-ai', mode: initialMode });

let conversationHistory = [];
let currentMode = initialMode;
let isLoading   = false;

const summaryForm   = document.getElementById('summaryForm');
const summaryEmail  = document.getElementById('summaryEmail');
const summarySubmit = document.getElementById('summarySubmit');
const summaryStatus = document.getElementById('summaryStatus');

// ─── Mode Toggle ─────────────────────────────────────────────────────────────
const modeToggle  = document.getElementById('modeToggle');
const personalLbl = document.getElementById('personalLabel');
const estateLbl   = document.getElementById('estateLabel');

modeToggle.addEventListener('change', () => {
  currentMode = modeToggle.checked ? 'estate' : 'personal';
  track('mode_toggle', { app: 'malpractice-ai', mode: currentMode });
  sessionId = sessionIds[currentMode];
  setCookie('malpractice_session', sessionId, 90);

  conversationHistory = [];
  contactShared = false;
  updateModeUI();
  const conv = document.getElementById('conversation');
  conv.innerHTML = '';
  appendMessage('ai', getModeWelcome());
  document.getElementById('analysisCard').style.display = 'none';
  document.getElementById('casesCard').style.display    = 'none';
  restoreConversation();
});

function updateModeUI() {
  const isEstate = currentMode === 'estate';
  document.body.classList.toggle('estate-mode', isEstate);
  modeToggle.checked = isEstate;
  personalLbl.classList.toggle('active', !isEstate);
  estateLbl.classList.toggle('active', isEstate);
  document.getElementById('heroTitle').textContent   = isEstate ? 'Wrongful Death Malpractice\nfor New York Families' : 'Medical Malpractice Legal AI\nfor New York';
  document.getElementById('heroSubtitle').textContent = isEstate
    ? 'Your loved one deserved better care. Get matched with a New York malpractice firm that handles cases like your family\'s.'
    : 'Describe what happened. Get matched with a New York malpractice firm that handles cases like yours.';
  document.getElementById('chatTitle').textContent  = isEstate ? 'Wrongful Death Claim Advisor' : 'Malpractice Case Advisor';
  document.getElementById('inputLabel').textContent = isEstate ? 'Describe what happened to your loved one' : 'Describe your situation';
  document.getElementById('userInput').placeholder  = isEstate
    ? 'Who passed away, when, and what was the alleged medical error?'
    : 'What happened, and when? What provider or facility was involved?';
  document.getElementById('solTitle').textContent = isEstate ? 'Wrongful Death SOL' : 'NY Statute of Limitations';
  document.getElementById('solText').innerHTML = isEstate
    ? '<strong style="color:var(--text)">Wrongful death:</strong> 2 years from date of death (EPTL §5-4.1)<br><br><strong style="color:var(--text)">Public hospitals:</strong> notice of claim within 90 days after an administrator is appointed<br><br><strong style="color:var(--text)">Federal providers</strong> (VA and military hospitals, many community health centers): written claim to the agency, generally within 2 years<br><br>The action is brought by the estate administrator, not the family directly. Estate appointment may be required first. <em>Act promptly.</em>'
    : '<strong style="color:var(--text)">Personal injury:</strong> 2.5 years from the act or omission, or from the last treatment for the same condition<br><br><strong style="color:var(--text)">City and county hospitals:</strong> notice of claim within 90 days; lawsuit within 1 year and 90 days. State hospitals: claim or notice of intention within 90 days<br><br><strong style="color:var(--text)">Federal providers</strong> (VA and military hospitals, many community health centers): written claim to the agency, generally within 2 years<br><br><strong style="color:var(--text)">Wrongful death:</strong> 2 years from date of death<br><br>Later deadlines: foreign object (1 year from discovery), missed cancer diagnosis (Lavern’s Law, up to 7 years), infancy (no more than 10 years). <em>Act promptly.</em>';
}

function getModeWelcome() {
  if (currentMode === 'estate') {
    return 'I\'m deeply sorry for your loss. I\'ll ask a few questions about what happened and, when your family is ready, match you with a New York malpractice firm that handles cases like yours.<br><br>When a family member dies because of a healthcare provider\'s negligence, the estate can seek accountability and compensation, but the deadline is only <strong>2 years from the date of death</strong>.<br><br><strong>To get started</strong> — tell me about your loved one: who they were, what the alleged medical error was, and when they passed away.';
  }
  return 'Welcome. I\'ll ask a few questions about what happened and, when you\'re ready, match you with a New York malpractice firm that handles cases like yours.<br><br><strong>To get started</strong> — tell me what happened. What type of provider was involved, and what injury resulted?';
}

// ─── Submit ───────────────────────────────────────────────────────────────────
// The server answers within about 40 seconds or says it could not; past this the page stops waiting.
const REPLY_TIMEOUT_MS = 70_000;
const NOT_ANSWERED = 'Sorry, something went wrong and your message was not answered. It is back in the box below: please send it again.';

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
  const userMsg = appendMessage('user', escHtml(q));
  input.value = '';

  const thinking = appendThinking();
  announce('Your message was sent. The answer usually takes 10 to 20 seconds.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPLY_TIMEOUT_MS);
  let answered = false;   // the server answered and saved the turn

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, mode: currentMode, sessionId, history: conversationHistory }),
      signal: controller.signal,
    });
    // A slow or failed reply may not be JSON at all (the host's own error page).
    const data = await res.json().catch(() => null);

    thinking.remove();

    if (!res.ok || typeof data?.answer !== 'string') {
      // The server's own words when it refused the message (too long, too many) or could not answer in time.
      returnQuestion(userMsg, input, q, [400, 429, 503].includes(res.status) && typeof data?.error === 'string' ? data.error : NOT_ANSWERED);
      return;
    }

    conversationHistory.push({ role: 'user', content: q });
    conversationHistory.push({ role: 'assistant', content: data.answer });
    answered = true;

    appendMessage('ai', markdownToHtml(data.answer));

    if (data.cases?.length) renderCases(data.cases);
    if (data.caseAnalysis)  renderCaseAnalysis(data.caseAnalysis, data.caseType, data.leadTier);
    showDeadlineNotices(data);
    if (data.contactForm)   offerContactForm();

  } catch (err) {
    thinking.remove();
    // The reply arrived and was saved; only showing part of it failed. Rolling back would offer to send the
    // question again, which would repeat it in the saved conversation.
    if (answered) { console.error('Showing the reply failed:', err); return; }
    returnQuestion(userMsg, input, q, NOT_ANSWERED);
  } finally {
    clearTimeout(timer);
    isLoading = false;
    setLoading(false);
  }
}

// The question is not lost: the unanswered message leaves the conversation and goes back in the box. It used
// to be cleared, with only an error in its place.
function returnQuestion(userMsg, input, question, notice) {
  userMsg.remove();
  if (!input.value) input.value = question;
  const note = appendMessage('ai', '');
  note.classList.add('msg-notice');
  note.textContent = notice;
}

// Read out by screen readers (the status region in index.html): the 10 to 20 second wait used to be silent.
function announce(text) {
  const region = document.getElementById('chatStatus');
  if (!region) return;
  region.textContent = '';
  setTimeout(() => { region.textContent = text; }, 50);
}

document.getElementById('userInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitQuestion(); }
});

// ─── Deadline notices ─────────────────────────────────────────────────────────
// Shown once each, beside the reply, when the visitor names a provider with a far shorter deadline than the
// usual one: a city, county or State hospital (90-day notice) or a federal provider (2-year claim). The
// server decides which (deadlines.js); a page loaded before the list existed gets only deadlineNotice.
const DEADLINE_TEMPLATES = { public_hospital: 'publicHospitalNoticeTemplate', federal: 'federalNoticeTemplate' };

function showDeadlineNotices(data) {
  const codes = Array.isArray(data?.deadlineNotices) ? data.deadlineNotices
    : data?.deadlineNotice === 'public_hospital' ? ['public_hospital'] : [];
  for (const code of codes) {
    const templateId = DEADLINE_TEMPLATES[code];
    if (!templateId || document.querySelector(`#conversation .deadline-notice[data-notice="${code}"]`)) continue;
    const notice = document.getElementById(templateId).content.firstElementChild.cloneNode(true);
    notice.querySelector(currentMode === 'estate' ? '.deadline-personal' : '.deadline-estate').remove();
    document.getElementById('conversation').appendChild(notice);
    notice.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ─── Contact form ─────────────────────────────────────────────────────────────
// Offered from the referral step. Nothing goes to a law firm until the visitor submits it with the
// consent box checked; the server then hands the lead off with these details.
let contactShared = false;

function offerContactForm() {
  if (contactShared) return;
  const conversation = document.getElementById('conversation');
  const existing = conversation.querySelector('.contact-card');
  const form = existing || document.getElementById('contactFormTemplate').content.firstElementChild.cloneNode(true);
  if (!existing) form.addEventListener('submit', submitContactForm);
  conversation.appendChild(form);
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function submitContactForm(event) {
  event.preventDefault();
  const form    = event.currentTarget;
  const errorEl = form.querySelector('.contact-error');
  const button  = form.querySelector('.contact-submit');
  errorEl.textContent = '';
  if (!form.elements.consent.checked) { errorEl.textContent = 'Please check the box to agree to be contacted.'; return; }
  const body = {
    sessionId,
    name: form.elements.name.value,
    phone: form.elements.phone.value,
    email: form.elements.email.value,
    bestTime: form.elements.bestTime.value,
    consent: true,
  };
  button.disabled = true;
  try {
    const res  = await fetch('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { errorEl.textContent = data.error || 'Something went wrong. Please try again.'; return; }
    track('contact_form_submitted', { app: 'malpractice-ai', case_type: data.caseType || 'other', lead_tier: data.leadTier || 'unscored' });
    contactShared = true;
    form.replaceWith(contactDoneMessage());
  } catch {
    errorEl.textContent = 'Network error — please check your connection and try again.';
  } finally {
    button.disabled = false;
  }
}

function contactDoneMessage() {
  const done = document.createElement('div');
  done.className = 'msg msg-ai contact-done';
  done.textContent = 'Thank you. Your request has been received, and a qualified New York malpractice attorney may contact you.';
  return done;
}

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
  div.setAttribute('aria-hidden', 'true');   // the status region says it once (announce)
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

function renderCaseAnalysis(analysis, caseType, leadTier) {
  track('case_analysis_viewed', { app: 'malpractice-ai', case_type: caseType || 'other', lead_tier: leadTier || 'unscored', verdict: analysis.verdict, score: analysis.score });
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
  summaryStatus.textContent = '';
  summarySubmit.disabled = false;
  card.style.display = 'block';
}

summaryForm.addEventListener('submit', async event => {
  event.preventDefault();
  summarySubmit.disabled = true;
  summaryStatus.textContent = 'Sending…';
  try {
    const response = await fetch('/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, email: summaryEmail.value.trim() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      summaryStatus.textContent = data.error || 'The summary could not be sent. Please try again.';
      summarySubmit.disabled = false;
      return;
    }
    summaryStatus.textContent = 'Summary sent. Check your inbox.';
  } catch {
    summaryStatus.textContent = 'The summary could not be sent. Please try again.';
    summarySubmit.disabled = false;
  }
});

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
  const button = document.getElementById('submitBtn');
  button.disabled    = on;
  document.getElementById('btnText').style.display = on ? 'none' : '';
  document.getElementById('btnSpinner').style.display = on ? 'block' : 'none';
  // With its text hidden behind the spinner, the button still has a name for screen readers.
  if (on) button.setAttribute('aria-label', 'Sending your message'); else button.removeAttribute('aria-label');
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
async function restoreConversation() {
  const requestedSession = sessionId;
  try {
    const res  = await fetch(`/api/conversations/${requestedSession}`);
    const data = await res.json();
    if (sessionId !== requestedSession) return;
    if (data.contact_consent_at) contactShared = true;
    if (!data.history?.length) return;

    conversationHistory = data.history;
    currentMode = data.mode || currentMode;
    updateModeUI();

    const conv = document.getElementById('conversation');
    conv.innerHTML = '';
    for (const msg of data.history) {
      const div = document.createElement('div');
      div.className = `msg msg-${msg.role === 'user' ? 'user' : 'ai'}`;
      div.innerHTML = msg.role === 'user' ? escHtml(msg.content) : markdownToHtml(msg.content);
      conv.appendChild(div);
    }
    showDeadlineNotices(data);
    // The contact form comes back if it was offered and not yet sent (or the note that it was); it used to be
    // lost on reload.
    if (data.contact_consent_at) conv.appendChild(contactDoneMessage());
    else if (data.contactForm) offerContactForm();
    conv.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
  } catch {}
}
updateModeUI();
if (initialMode === 'estate') {
  const conv = document.getElementById('conversation');
  conv.innerHTML = '';
  appendMessage('ai', getModeWelcome());
}
restoreConversation();

document.querySelectorAll('.quick-start').forEach(button => {
  button.addEventListener('click', () => {
    track('quick_start_selected', { app: 'malpractice-ai', case_type: button.dataset.caseType || 'other' });
    const input = document.getElementById('userInput');
    input.value = button.dataset.question || '';
    input.focus();
  });
});

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
