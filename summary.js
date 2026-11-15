import { APP_URL, APP_ID, caseTypeLabel } from './site.js';

const BRAND = process.env.APP_BRAND || (APP_ID === 'nycinjury' ? 'NYCInjury.ai' : 'NYCMalpractice.ai');
const DEADLINE_LABELS = {
  government: 'a possible 90-day government notice deadline',
  port_authority: 'a possible 1-year Port Authority filing deadline',
  federal: 'a possible 2-year federal claim deadline',
  no_fault: 'a possible 30-day no-fault application deadline',
  public_hospital: 'a possible 90-day public hospital notice deadline',
};

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function buildSummaryEmail(conv, deadlineCodes = []) {
  const score = conv.lead_score || {};
  const history = Array.isArray(conv.history) ? conv.history : [];
  const latestAssessment = [...history].reverse().find(message => message?.role === 'assistant' && typeof message.content === 'string')?.content || '';
  const caseType = conv.pi_type || conv.case_type;
  const lines = [`Case type: ${caseTypeLabel(caseType)}`];
  if (score.preview) lines.push(`Case summary: ${score.preview}`);
  if (Number.isFinite(score.score)) lines.push(`Preliminary score: ${score.score}/100`);
  if (latestAssessment) lines.push(`Latest assessment: ${latestAssessment}`);
  const deadlines = deadlineCodes.map(code => DEADLINE_LABELS[code]).filter(Boolean);
  if (deadlines.length) lines.push(`Possible deadline warnings: ${deadlines.join('; ')}`);
  lines.push('This is a preliminary AI assessment, not legal advice or a prediction of the outcome.');
  lines.push(`Return to ${BRAND}: ${APP_URL}`);
  lines.push('If you return on the device you used before, your saved conversation may still be available.');

  const html = `<div style="font-family:sans-serif;max-width:640px;margin:auto;line-height:1.6"><h2>Your ${escapeHtml(BRAND)} case summary</h2><ul>${lines.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul><p><a href="${escapeHtml(APP_URL)}">Return to ${escapeHtml(BRAND)}</a></p></div>`;
  return { subject: `Your ${BRAND} case summary`, html, text: lines.join('\n\n') };
}
