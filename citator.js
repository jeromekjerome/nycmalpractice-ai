// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Proprietary and confidential. See LICENSE for terms.

// citator.js — Deterministic legal citation & authority verifier.
//
// Ported from the Gatekeeper & Coach citator (backend/citator.py). No model is involved: case
// citations are pulled out of a draft with regular expressions and each one is classified against
// the CourtListener cases that were actually retrieved for this turn (the "context packet"):
//
//   ANCHORED            — the case name / reporter citation is in the retrieved packet
//   PLACEHOLDER_FLAGGED — not in the packet, but the author marked it [VERIFY CITATION Needed]
//   UNANCHORED          — not in the packet and not flagged: treated as a hallucination
//
// Optionally, reporter citations that are not anchored are checked against CourtListener's
// citation-lookup API to record whether they exist at all.

const CL_CITATION_LOOKUP_URL = 'https://www.courtlistener.com/api/rest/v4/citation-lookup/';
const CL_LOOKUP_TIMEOUT_MS = 4000;

export const VERIFY_PLACEHOLDER = '[VERIFY CITATION Needed]';

// Text beyond this length is not audited. A model reply is a few thousand characters; the cap
// bounds the work done on anything else that is passed in (for example a user's own message).
const MAX_AUDIT_CHARS = 30000;

// ─── Patterns ──────────────────────────────────────────────────────────────────

// Reporters. Bluebook forms ("57 N.Y.2d 230") and the New York Official Reports style that
// New York opinions themselves use ("57 NY2d 230", "142 AD3d 101") are both accepted, along with
// the federal and regional reporters a national search can put in the packet. Single-letter and
// period-less forms require a series suffix so prose ("Albany NY 12207") is not mistaken for one.
const S23 = String.raw`(?:2(?:d|nd)|3(?:d|rd))`;                 // 2d, 2nd, 3d, 3rd
const S234 = String.raw`(?:2(?:d|nd)|3(?:d|rd)|4th)`;
const S2345 = String.raw`(?:2(?:d|nd)|3(?:d|rd)|4th|5th)`;
// State reports cited by the state's name ("244 N.J. 199", "489 Mass. 1"). New York has its own
// entries below; the period is required wherever the abbreviation has one.
const STATE_ABBREVIATIONS =
  String.raw`(?:(?:Ala|Ariz|Ark|Cal|Colo|Conn|Del|Fla|Ga|Haw|Ill|Ind|Kan|Ky|La|Me|Md|Mass|Mich|Minn|Miss|Mo|Mont|Neb|Nev|N\.\s?H|N\.\s?J|N\.\s?M|N\.\s?C|N\.\s?D|Okla|Or|Pa|R\.\s?I|S\.\s?C|S\.\s?D|Tenn|Tex|Vt|Va|Wash|W\.\s?Va|Wis|Wyo)\.|Alaska|Idaho|Iowa|Ohio|Utah)`;
const REPORTERS = [
  String.raw`N\.?\s?Y\.?\s+Slip\s+Op\.?`,                    // 2025 NY Slip Op 04470
  String.raw`(?:U\.\s?S\.|N\.\s?Y\.|[A-Z][a-z]+\.)(?:\s(?:Dist|App|Misc|Super|Sup)\.)*\s+LEXIS`,   // 2019 N.Y. Misc. LEXIS 1234
  String.raw`N\.\s?Y\.\s?S\.(?:\s?${S23})?`,                  // N.Y.S., N.Y.S.2d, N.Y.S.3d
  String.raw`NYS\s?${S23}`,                                   // NYS2d, NYS3d
  String.raw`N\.\s?Y\.(?:\s?${S23})?`,                        // N.Y., N.Y.2d, N.Y.3d
  String.raw`NY\s?${S23}`,                                    // NY2d, NY3d
  String.raw`A\.\s?D\.(?:\s?${S234})?`,                       // A.D., A.D.2d, A.D.3d (also "A.D.3rd")
  String.raw`AD\s?${S234}`,                                   // AD2d, AD3d
  String.raw`App\.?\s+Div\.?`,                                // 270 App Div 112
  String.raw`Misc\.(?:\s?${S23})?`,                           // Misc., Misc. 2d, Misc. 3d
  String.raw`Misc\s?${S23}`,                                  // Misc 3d
  String.raw`N\.\s?E\.(?:\s?${S23})?`,                        // N.E., N.E.2d, N.E.3d
  String.raw`NE\s?${S23}`,                                    // NE2d, NE3d
  String.raw`U\.\s?S\.`,                                      // U.S.
  String.raw`S\.?\s?Ct\.?`,                                   // S. Ct., S Ct
  String.raw`L\.?\s?Ed\.?(?:\s?2d)?`,                         // L. Ed., L. Ed. 2d, L Ed 2d
  String.raw`F\.?\s?Supp\.?(?:\s?${S23})?`,                   // F. Supp., F. Supp. 2d, F Supp 3d
  String.raw`F(?:ed)?\.?\s?App['’]?x\.?`,                     // F. App'x, Fed. Appx.
  String.raw`F\.?\s?${S234}`,                                 // F.2d, F.3d, F.4th, F3d
  String.raw`A\.?\s?${S23}`,                                  // A.2d, A.3d, A3d
  String.raw`N\.\s?W\.|N\.?\s?W\.?\s?${S23}`,                 // N.W., N.W.2d, NW2d
  String.raw`P\.?\s?${S23}`,                                  // P.2d, P.3d, P3d
  String.raw`S\.\s?E\.|S\.?\s?E\.?\s?2d`,                     // S.E., S.E.2d, SE2d
  String.raw`S\.\s?W\.|S\.?\s?W\.?\s?${S23}`,                 // S.W., S.W.2d, SW3d
  String.raw`So\.?\s?${S23}`,                                 // So. 2d, So. 3d, So 3d
  String.raw`Cal\.?\s?Rptr\.?(?:\s?${S23})?`,                 // Cal. Rptr., Cal. Rptr. 2d
  String.raw`Cal\.?\s?(?:App\.?\s?)?${S2345}`,                // Cal.4th, Cal. App. 4th, Cal 4th
  String.raw`${STATE_ABBREVIATIONS}(?:\s?(?:St|App|Super|Cmwlth|Ct)\.){0,2}(?:\s?${S2345})?`,   // 244 N.J. 199, 60 Ohio St. 3d 1
  String.raw`WL`,                                             // 2019 WL 1234567
];
const REPORTER_ALTERNATION = REPORTERS.join('|');

// volume · reporter · page. The page is numeric: "550 U.S. 544" is a citation, "50 U.S. states"
// and "1600 N.W. 5th Street" are not.
const REPORTER_SOURCE = String.raw`\b(\d{1,4})\s+(${REPORTER_ALTERNATION})\s+(\d+)\b`;
// Short-form pin cite: "999 N.Y.3d at 115".
const SHORT_REPORTER_SOURCE = String.raw`\b(\d{1,4})\s+(${REPORTER_ALTERNATION})\s+at\s+(\d+)\b`;
// First-series reports in the official style, which drops the periods: "248 NY 339", "477 US 317".
// The volume and page are bounded so that neither a year nor a ZIP code ("NY 10001") fits.
const BARE_FIRST_SERIES_SOURCE = String.raw`\b(\d{1,3})\s+(NY|US)\s+(\d{1,4})\b`;
// A slip opinion cited without its year: "NY Slip Op 02550". Numbers restart every year, so this
// can only be matched to a retrieved slip opinion by its number.
const SLIP_OP_WITHOUT_YEAR_SOURCE = String.raw`\b()(N\.?\s?Y\.?\s+Slip\s+Op\.?)\s+(\d{4,6})\b`;

// "Party v. Party" captions. A party token is a capitalised word of 2+ characters. The defendant
// may begin with a street number ("Mejia v. 2959 Fulton St. Realty"), a lowercase particle or
// brand ("Smith v. de la Cruz", "Smith v. eBay Inc.", "Smith v. the City of New York"), or a
// single letter or digit before another capitalised word ("K Mart", "A & P", "2 Broadway"); it may
// contain a lowercase connector or an ampersand. Unicode-aware so "Peña v. Muñoz" is not missed.
// Token lengths are bounded, which no real name notices and which keeps matching linear.
const TOKEN_CHARS = String.raw`\p{L}\p{N}&'’.\-/`;
const CAP_TOKEN = String.raw`\p{Lu}[${TOKEN_CHARS}]{1,40}`;
// Words after the first may be a single capital ("Avis Rent A Car", "John Q Public").
const CAP_TOKEN_CONT = String.raw`\p{Lu}[${TOKEN_CHARS}]{0,40}`;
const PARTICLES = String.raw`(?:de|del|della|di|da|la|le|van|von|der|den|ter|el|al|bin|ibn)`;
const DEFENDANT_FIRST_TOKEN =
  String.raw`(?:the\s+)?(?:${PARTICLES}\s+){0,2}` +
  String.raw`(?:[\p{Lu}\d][${TOKEN_CHARS}]{1,40}|\p{Ll}{1,3}\p{Lu}[${TOKEN_CHARS}]{0,40}|[\p{Lu}\d](?=\s+(?:&\s+)?\p{Lu}))`;
const CONNECTOR = String.raw`(?:of(?:\s+the)?|for(?:\s+the)?|de|del|la|&)`;
// A caption can only begin at the start of a word. Besides being what a caption looks like, this
// keeps matching linear: without it every capital inside "A.A.A.A…" is a fresh starting point
// that scans to the end of the run.
const CAPTION_START = String.raw`(?<![\p{L}\p{N}&’.\-/])(?<![\p{L}\p{N}]')`;
// Only "v." / "v" separates parties. "vs." is deliberately not accepted: it is how ordinary prose
// writes a comparison ("Actual vs. Constructive Notice"), and treating it as a caption would
// block replies over their own headings.
const CAPTION_SOURCE =
  String.raw`${CAPTION_START}(?:Matter\s+of\s+)?${CAP_TOKEN}(?:\s+(?:${CAP_TOKEN_CONT}|\d{1,4}(?=\s+v\.?\s))){0,4}(?:,?\s+et\s+al\.?,?)?` +
  String.raw`\s+v\.?\s+` +
  // (A street ordinal may sit inside the name: "334 E. 92nd Hous. Dev. Fund Corp.")
  String.raw`${DEFENDANT_FIRST_TOKEN}(?:\s+(?:${CONNECTOR}\s+)?(?:${CAP_TOKEN_CONT}|\d{1,4}(?:st|nd|rd|th)(?=\s+\p{Lu}))){0,6}`;

const PARTY_SEPARATOR = /\s+v\.?\s+/;

// "[VERIFY CITATION Needed]" and the close variants the reference citator accepts.
const PLACEHOLDER_SOURCE = String.raw`\[\s*(?:VERIFY\s+CITATION(?:\s+NEEDED)?|CITATION\s+NEEDED|VERIFY)\s*\]`;
// A placeholder excuses the one citation it is attached to: the citation it follows in the same
// sentence and on the same line (within this many characters), or failing that the citation it
// immediately precedes.
const PLACEHOLDER_MAX_GAP_AFTER_CITATION = 85;
const PLACEHOLDER_MAX_GAP_BEFORE_CITATION = 40;
const SENTENCE_BREAK = /[.!?]["'”’)\]]*\s+(?=["'“‘(\[]*[\p{Lu}\d])|\n/u;

// Text allowed between a case name and its reporter citation. Besides the Bluebook comma
// (", Inc., 12 N.Y.3d 345") this covers the New York official style, which puts the citation in
// parentheses after the name ("Smith v Jones (12 NY3d 345 [2009])"), a possessive, "supra", and
// the separators of a list or table. A semicolon is not one: it separates two authorities.
const CAPTION_TO_REPORTER_GAP =
  /^(?:['’]s)?(?:\s*,?\s*(?:Inc|LLC|L\.L\.C|Corp|Co|Ltd|L\.P|LLP|P\.C|et\s+al)\.?)*[\s,:()\[\]|—–-]*(?:\d{4}[\s,:()\[\]|—–-]*)?(?:supra[\s,]*)?$/i;
// Between parallel citations: a comma or semicolon, with an optional pin page ("…345, 350, 746 N.Y.S.2d 865").
const PARALLEL_REPORTER_GAP = /^\s*[,;]\s*(?:\d{1,5}(?:\s*[-–]\s*\d{1,5})?\s*[,;]\s*)?$/;
const MAX_GAP_CHARS = 40;

// Text after a case name that shows the name goes on: "Jones (Bronx) Realty", "Jones 2 Realty".
// A court-and-year note ("(2d Dept 2022) The court…") or a year is not that.
const NAME_CONTINUES = /^\s+(?:\(\p{Lu}[\p{L}.]{0,15}\)\s+\p{Lu}|\d{1,3}\s+\p{Lu})/u;

// Capitalised words that open a sentence or introduce a citation. They are trimmed from the
// front of a caption ("In Smith v. Jones" → "Smith v. Jones") and end a caption when they follow
// an abbreviation ("Carrier Corp. In that case" → "Carrier Corp.").
const NOISE_WORDS = new Set([
  'In', 'See', 'Under', 'As', 'Per', 'Cf.', 'Cf', 'But', 'And', 'Or', 'Also', 'The', 'Like', 'Unlike',
  'Following', 'Citing', 'Quoting', 'Accord', 'Consider', 'Recall', 'Remember', 'Take', 'Applying',
  'Here', 'There', 'While', 'Although', 'Because', 'Since', 'After', 'Before', 'When', 'Where',
  'Both', 'Compare', 'Contrast', 'With', 'From', 'For', 'To', 'On', 'At', 'By', 'That', 'This',
  'These', 'Those', 'Then', 'Thus', 'So', 'Yet', 'If', 'Is', 'Was', 'Were', 'Are', 'Does', 'Did',
  'Do', 'Would', 'Could', 'Should', 'How', 'What', 'Why', 'Who', 'Which', 'Suppose', 'Imagine',
  'Think', 'Even', 'Only', 'Just', 'Now', 'Next', 'Finally', 'Similarly', 'Instead', 'However',
  'Moreover', 'Indeed', 'Notably', 'E.g.', 'I.e.', 'It', 'Its', 'You', 'Your', 'We', 'Our', 'They',
  'Their', 'Each', 'Every', 'Some', 'Most', 'Many', 'Not', 'Let', 'Note', 'Given', 'Based', 'Look',
  'Looking', 'Turning', 'Returning', 'Back', 'Again', 'A', 'An', 'I',
]);

// Abbreviations that legitimately end in a period inside a party name. New York's official
// reports abbreviate case names heavily ("Eden Cent. School Dist.", "Metro. Transp. Auth.",
// "Consol. Edison Co."), and those are the names CourtListener returns, so the list follows the
// official style manual's case-name abbreviations.
const NAME_ABBREVIATIONS = new Set(`
  admin affil agric am apt apts assn assoc assocs auth auto ave bd bldg bldrs blvd bros bur bus
  cas cent chem civ cmty co coll commn commr commrs condo consol constr contr coop corp corr ct
  ctr cnty dept dev dist distrib div dr educ elec elev empls engrg enters envtl equip exch fed
  fedn fid fin found ft gen govt guar hgts hosp hous hwy imp inc indem indep indus ins inst intl
  inv is jr lab liab ltd mach maint mdse med metro mfg mfrs mgmt mgt mkt mktg mr mrs ms mt mtge
  mun mut natl no org pac pkwy prods prof prop props prot pub rd refrig rehab reins res rest ry
  sav sch schs sec serv servs soc sq sr st sta sts sur sys tel telecom tr transp twp univ util
  vil llc llp lp pc al
`.split(/\s+/).filter(Boolean));

// The ones that normally close a name ("… Hosp.", "… Corp."), as opposed to opening one ("St. …").
const NAME_ENDING_ABBREVIATIONS = new Set([
  'corp', 'inc', 'co', 'ltd', 'llc', 'llp', 'lp', 'pc', 'hosp', 'auth', 'assn', 'assoc', 'assocs',
  'dept', 'sys', 'ctr', 'univ', 'bros', 'servs', 'mgt', 'mgmt', 'indus', 'props', 'prods', 'ry',
]);

// ─── Normalisation helpers ─────────────────────────────────────────────────────

function fold(value) {
  return String(value ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

// Letters and digits only, in any script (so a name in Cyrillic does not collapse to nothing).
function alnumKey(value) {
  return fold(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Loose text form used for "does this caption appear in the packet text": markup dropped, periods
// and apostrophes removed (so "v." ≡ "v" and "Hosp." ≡ "Hosp"), everything else collapsed.
function looseText(value) {
  return fold(value)
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[.'’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function collapseWhitespace(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

// The part of a text that is audited. A longer text is cut at the last line or sentence break
// before the limit (failing that, at the last space), so that no citation is cut in half.
function auditWindow(value) {
  const text = String(value ?? '');
  if (text.length <= MAX_AUDIT_CHARS) return text;
  const head = text.slice(0, MAX_AUDIT_CHARS);
  const floor = MAX_AUDIT_CHARS - 600;
  const sentenceEnd = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('. '));
  if (sentenceEnd >= floor) return head.slice(0, sentenceEnd + 1);
  const space = head.lastIndexOf(' ');
  return space >= floor ? head.slice(0, space) : head;
}

// The text the patterns run on: the audited part, with Markdown emphasis markers blanked out so
// "**Smith** v. **FakeCorp**" reads as "Smith v. FakeCorp". Every replacement is one character
// for one character, so offsets into this text are offsets into the original.
function matchable(draftText) {
  return auditWindow(draftText).replace(/[*_`]/g, ' ');
}

// "57 N.Y.2d 230", "57 NY2d 230" and "57 N.Y.2nd 230" share the key "57|ny2d|230".
function reporterName(reporter) {
  return alnumKey(reporter).replace(/2nd/g, '2d').replace(/3rd/g, '3d');
}

function reporterPrefix(volume, reporter) {
  return `${volume}|${reporterName(reporter)}|`;
}

function pageKey(page) {
  return String(page).replace(/^0+(?=\d)/, '');
}

function reporterKey(volume, reporter, page) {
  return `${reporterPrefix(volume, reporter)}${pageKey(page)}`;
}

function isInitials(token) {
  return /^(?:\p{Lu}\.)+$/u.test(token);
}

function isNameAbbreviation(token) {
  if (isInitials(token)) return true;
  return NAME_ABBREVIATIONS.has(alnumKey(token));
}

// ─── Extraction ────────────────────────────────────────────────────────────────

// Reporter citations in `text`, in order: { text, key, prefix, suffix, short, start, end }.
// A full citation has a key (volume|reporter|page). A short-form pin cite ("999 N.Y.3d at 115") has
// no first page, so it has only a prefix; a slip opinion cited without its year has only a suffix.
function findReporters(text) {
  const found = [];
  const collect = (source, form) => {
    const re = new RegExp(source, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (found.some(f => start < f.end && end > f.start)) continue;
      found.push({
        text: collapseWhitespace(m[0]),
        key: form === 'full' ? reporterKey(m[1], m[2], m[3]) : null,
        prefix: form === 'suffix' ? null : reporterPrefix(m[1], m[2]),
        suffix: form === 'suffix' ? `|${reporterName(m[2])}|${pageKey(m[3])}` : null,
        short: form !== 'full',
        start,
        end,
      });
    }
  };
  collect(REPORTER_SOURCE, 'full');
  collect(SHORT_REPORTER_SOURCE, 'prefix');
  collect(BARE_FIRST_SERIES_SOURCE, 'full');
  collect(SLIP_OP_WITHOUT_YEAR_SOURCE, 'suffix');
  return found.sort((a, b) => a.start - b.start);
}

// Trim lead-in words, trailing sentence starters, trailing punctuation and possessives from a raw
// caption match. Returns the cleaned caption with its exact span in the draft, or null.
//   context.original — the text before emphasis markers were blanked (same offsets)
//   context.after    — the text that follows the raw match
//   context.minStart — where the previous caption ended; this one cannot reach back past it
function refineCaption(raw, rawStart, context = {}) {
  const sep = PARTY_SEPARATOR.exec(raw);
  if (!sep) return null;
  const original = context.original ?? null;
  const after = context.after ?? '';
  const minStart = context.minStart ?? 0;

  // Tokens with their offsets inside `raw`.
  const tokens = [];
  const tokenRe = /\S+/g;
  let t;
  while ((t = tokenRe.exec(raw)) !== null) tokens.push({ text: t[0], start: t.index, end: t.index + t[0].length });

  const sepStart = sep.index;
  const sepEnd = sep.index + sep[0].length;
  let left = tokens.filter(tok => tok.end <= sepStart && rawStart + tok.start >= minStart);
  let right = tokens.filter(tok => tok.start >= sepEnd);
  if (!left.length || !right.length) return null;

  // A party name does not run across a line break or across the end of a run of bold or italic
  // text: the heading or label before the caption, and whatever follows it, are not part of it.
  const splitsName = (list, i) => {
    if (raw.slice(list[i - 1].end, list[i].start).includes('\n')) return true;
    return original !== null && /[*_`]/.test(original.slice(rawStart + list[i - 1].end, rawStart + list[i].start));
  };
  for (let i = left.length - 1; i > 0; i--) {
    if (splitsName(left, i)) { left = left.slice(i); break; }
  }
  for (let i = 1; i < right.length; i++) {
    if (splitsName(right, i)) { right = right.slice(0, i); break; }
  }

  // Plaintiff side: drop everything up to and including a sentence-ending word
  // ("…in Manhattan. Smith v. Jones"), then drop lead-in words ("In", "See", …). A lone word is
  // kept even if it looks like a lead-in: before "v." it is a surname (An, So, Do, To).
  for (let i = left.length - 2; i >= 0; i--) {
    if (left[i].text.endsWith('.') && !isNameAbbreviation(left[i].text)) {
      left = left.slice(i + 1);
      break;
    }
  }
  while (left.length > 1 && NOISE_WORDS.has(left[0].text)) left = left.slice(1);

  // Defendant side: stop where the sentence ends — at a word that closes the sentence
  // ("Carrier. Smith v. …") or a sentence starter that follows an abbreviation ("Corp. In that case").
  for (let i = 0; i < right.length - 1; i++) {
    const endsSentence = right[i].text.endsWith('.') && !isNameAbbreviation(right[i].text);
    const nextStartsSentence = right[i].text.endsWith('.') && NOISE_WORDS.has(right[i + 1].text);
    if (endsSentence || nextStartsSentence) {
      right = right.slice(0, i + 1);
      break;
    }
  }
  // "…v. Prospect Hosp. Courts apply it strictly": when the text carries on in lower case (or
  // with the "v." of the next caption), the capitalised words after the last abbreviation are
  // the start of the next sentence, not the end of this name.
  if (/^\s+\p{Ll}/u.test(after)) {
    let lastAbbreviation = -1;
    for (let i = 0; i < right.length - 1; i++) {
      if (right[i].text.endsWith('.')) lastAbbreviation = i;
    }
    const closesName = lastAbbreviation !== -1 && NAME_ENDING_ABBREVIATIONS.has(alnumKey(right[lastAbbreviation].text));
    if (closesName && right.slice(lastAbbreviation + 1).every(tok => !tok.text.endsWith('.'))) {
      right = right.slice(0, lastAbbreviation + 1);
    }
  }
  while (right.length > 1 && NOISE_WORDS.has(right[right.length - 1].text)) right = right.slice(0, -1);
  // A connector left dangling by the trims above ("City of", "Stop &").
  while (right.length > 1 && /^(?:of|for|the|de|del|la|&)$/.test(right[right.length - 1].text)) right = right.slice(0, -1);

  const first = left[0];
  const last = { ...right[right.length - 1] };

  // Possessive and trailing punctuation on the final token.
  let lastText = last.text.replace(/['’]s$/u, '');
  lastText = lastText.replace(/[,;:]+$/, '');
  if (lastText.endsWith('.') && !isNameAbbreviation(lastText)) lastText = lastText.replace(/\.+$/, '');
  if (!lastText) return null;
  last.end = last.start + lastText.length;

  const start = rawStart + first.start;
  const end = rawStart + last.end;
  const text = collapseWhitespace(raw.slice(first.start, last.end));
  if (!PARTY_SEPARATOR.test(text)) return null;

  return { text, start, end };
}

// `text` is the matchable form of `original` (emphasis markers blanked, same offsets).
function findCaptions(text, original = text) {
  const found = [];
  const re = new RegExp(CAPTION_SOURCE, 'gu');
  let previousEnd = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const matchEnd = m.index + m[0].length;
    const refined = refineCaption(m[0], m.index, {
      original,
      after: text.slice(matchEnd, matchEnd + 8),
      minStart: previousEnd,
    });
    if (refined && !found.some(f => f.start === refined.start && f.end === refined.end)) {
      found.push(refined);
      previousEnd = refined.end;
    }
    // Resume right after the separator, so a caption whose plaintiff was swallowed as the tail of
    // the previous one ("…Driver v. Carrier. Smith v. FakeCorp…") is still found.
    const sep = PARTY_SEPARATOR.exec(m[0]);
    if (sep) re.lastIndex = Math.max(m.index + sep.index + sep[0].length, m.index + 1);
  }
  return found;
}

// Group captions with the reporter citation(s) that immediately follow them, then de-duplicate.
// `text` is the matchable form of `original` (emphasis markers blanked, same offsets).
// Internal shape: { citation_text, kind, caption, reporters[], spans[[start, end], …], … }
function collectCitations(text, original = text) {
  if (!text.trim()) return [];

  const reporters = findReporters(text);
  const captions = findCaptions(text, original);
  const usedReporter = new Set();
  const items = [];

  for (const caption of captions) {
    const attached = [];
    let cursor = caption.end;

    for (let i = 0; i < reporters.length; i++) {
      const rep = reporters[i];
      if (usedReporter.has(i) || rep.start < cursor) continue;
      const gap = text.slice(cursor, rep.start);
      if (gap.length > MAX_GAP_CHARS) break;
      const allowed = attached.length === 0 ? CAPTION_TO_REPORTER_GAP.test(gap) : PARALLEL_REPORTER_GAP.test(gap);
      if (!allowed) break;
      attached.push(rep);
      usedReporter.add(i);
      cursor = rep.end;
    }

    // Official style closes what it opened after the name: "(12 NY3d 345, 350 [2009])".
    if (attached.length && /[(\[]/.test(text.slice(caption.end, attached[0].start))) {
      const closing = /^(?:,\s*\d{1,5}(?:\s*[-–]\s*\d{1,5})?)?(?:\s*\[[^\]\n]{0,40}\])?\s*[)\]]/.exec(text.slice(cursor, cursor + 70));
      if (closing) cursor += closing[0].length;
    }

    // A heading is written in title case, so the words after a name in one are not part of it.
    const lineStart = text.lastIndexOf('\n', caption.start - 1) + 1;
    const inHeading = /^\s{0,3}#{1,6}\s/.test(text.slice(lineStart, lineStart + 12));

    if (attached.length) {
      items.push({
        // Blanked emphasis markers can leave a space before the comma ("Carrier , 210 A.D.3d 456").
        citation_text: collapseWhitespace(text.slice(caption.start, cursor)).replace(/\s+([,;])/g, '$1').replace(/([(\[])\s+/g, '$1'),
        kind: 'full',
        caption: caption.text,
        reporters: attached,
        start: caption.start,
        end: cursor,
        inHeading,
        nameContinues: false,
      });
    } else {
      items.push({
        citation_text: caption.text,
        kind: 'caption',
        caption: caption.text,
        reporters: [],
        start: caption.start,
        end: caption.end,
        inHeading,
        nameContinues: NAME_CONTINUES.test(text.slice(caption.end, caption.end + 40)),
      });
    }
  }

  reporters.forEach((rep, i) => {
    if (usedReporter.has(i)) return;
    // A reporter sitting inside a caption span was already consumed by that caption.
    if (items.some(item => rep.start >= item.start && rep.end <= item.end)) return;
    items.push({ citation_text: rep.text, kind: 'reporter', caption: null, reporters: [rep], start: rep.start, end: rep.end });
  });

  items.sort((a, b) => a.start - b.start);

  // De-duplicate by normalised text, keeping every occurrence's span.
  const unique = [];
  const byKey = new Map();
  for (const item of items) {
    const key = alnumKey(item.citation_text);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.spans.push([item.start, item.end]);
      existing.inHeading = existing.inHeading && Boolean(item.inHeading);
      existing.nameContinues = existing.nameContinues || Boolean(item.nameContinues);
      continue;
    }
    const entry = {
      citation_text: item.citation_text,
      kind: item.kind,
      caption: item.caption,
      reporters: item.reporters.map(r => ({ text: r.text, key: r.key, prefix: r.prefix, suffix: r.suffix, short: r.short })),
      spans: [[item.start, item.end]],
      // A name is only read leniently, or refused as running on, if every occurrence is like that.
      inHeading: Boolean(item.inHeading),
      nameContinues: Boolean(item.nameContinues),
    };
    byKey.set(key, entry);
    unique.push(entry);
  }
  return unique;
}

// The citations of a text: its matchable form is built here so the original is at hand for the
// checks that need to see emphasis markers.
function citationsIn(sourceText) {
  const original = auditWindow(sourceText);
  return collectCitations(matchable(original), original);
}

/**
 * Deterministically extract case citations (reporter citations and "Party v. Party" captions)
 * from a draft. A caption directly followed by its reporter citation is one item.
 *
 * @returns {Array<{citation_text: string, kind: 'full'|'caption'|'reporter', caption: string|null, reporters: string[], start: number, end: number}>}
 */
export function extractDraftCitations(draftText) {
  return citationsIn(draftText).map(item => ({
    citation_text: item.citation_text,
    kind: item.kind,
    caption: item.caption,
    reporters: item.reporters.map(r => r.text),
    start: item.spans[0][0],
    end: item.spans[0][1],
  }));
}

/**
 * A text with every extracted citation taken out: what it says apart from its citations. Used to
 * tell a complaint about a citation from a complaint about something else in the same sentence.
 */
export function textOutsideCitations(draftText) {
  const spans = citationsIn(draftText).flatMap(item => item.spans).sort((a, b) => b[0] - a[0]);
  let rest = matchable(draftText);
  for (const [start, end] of spans) rest = `${rest.slice(0, start)} ${rest.slice(end)}`;
  return rest;
}

// ─── Anchoring against the retrieved packet ────────────────────────────────────

// Words that carry no identity in a party name: "Board of Educ. of City of N.Y." is the "Board of
// Education of the City of New York", and "X & Y" is "X and Y" (the ampersand has no letters).
const SKIPPED_NAME_WORDS = new Set(['the', 'and']);

function partyTokens(side) {
  return side
    .split(/\s+/)
    .filter(Boolean)
    .map(raw => {
      const trimmed = raw.replace(/[,;:]+$/, '');
      return {
        norm: alnumKey(trimmed),
        abbr: trimmed.endsWith('.'),
        // "N.Y.", "R.R.": each letter stands for a word.
        initials: /^(?:\p{L}\.){2,}$/u.test(trimmed),
        // "Macy's" may be cited without its apostrophe-s, which reads like a possessive.
        base: /['’]s$/u.test(trimmed) ? alnumKey(trimmed.replace(/['’]s$/u, '')) : null,
      };
    })
    .filter(tok => tok.norm && !SKIPPED_NAME_WORDS.has(tok.norm));
}

function splitParties(name) {
  const text = collapseWhitespace(fold(name));
  const sep = PARTY_SEPARATOR.exec(text);
  if (!sep) return null;
  const left = partyTokens(text.slice(0, sep.index));
  const right = partyTokens(text.slice(sep.index + sep[0].length));
  // "Smith et al. v. …" is the Smith case.
  while (left.length > 2 && left[left.length - 1].norm === 'al' && left[left.length - 2].norm === 'et') left.splice(-2);
  if (!left.length || !right.length) return null;
  return { left, right };
}

// Equal, or one is an abbreviation of the other ("Hosp." ~ "Hospital", "Is." ~ "Island"), or one
// is the other without its apostrophe-s ("Macy" ~ "Macy's").
function tokensCompatible(a, b) {
  if (a.norm === b.norm) return true;
  if ((a.base && a.base === b.norm) || (b.base && b.base === a.norm)) return true;
  return abbreviates(a, b) || abbreviates(b, a);
}

// "Hosp." abbreviates "Hospital", "R.R." abbreviates "Railroad", "Natl." abbreviates "National":
// same first letter, and the abbreviation's letters appear in order in the full word.
function abbreviates(short, full) {
  if (!short.abbr || short.norm.length < 2 || short.norm.length >= full.norm.length) return false;
  if (short.norm[0] !== full.norm[0]) return false;
  let position = 0;
  for (const letter of short.norm) {
    position = full.norm.indexOf(letter, position);
    if (position === -1) return false;
    position += 1;
  }
  return true;
}

// Words a draft may add after a retrieved defendant's name without naming someone else.
const ENTITY_SUFFIXES = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'llc', 'llp', 'lp', 'ltd',
  'limited', 'pc', 'pllc', 'et', 'al', 'jr', 'sr',
]);

// How far two defendant names agree, word for word from the start. An initialism on one side may
// stand for as many words on the other ("N.Y." ~ "New York", "R.R." ~ "Rail Road"). Returns how
// many of the draft's words are accounted for, or -1 where the names part ways.
function alignDefendants(draft, retrieved) {
  const spelledOut = (short, words, at) =>
    short.initials && at + short.norm.length <= words.length &&
    [...short.norm].every((letter, k) => words[at + k].norm[0] === letter);

  let i = 0;
  let j = 0;
  while (i < draft.length && j < retrieved.length) {
    if (tokensCompatible(draft[i], retrieved[j])) { i += 1; j += 1; }
    else if (spelledOut(retrieved[j], draft, i)) { i += retrieved[j].norm.length; j += 1; }
    else if (spelledOut(draft[i], retrieved, j)) { j += draft[i].norm.length; i += 1; }
    else return -1;
  }
  return i;
}

// A draft caption refers to a retrieved case when the words on either side of the "v." line up:
// the plaintiff's last word, and every defendant word the two names have in common from the
// start. That tolerates the truncations and lead-ins a caption regex produces ("Rodriguez v. City"
// ↔ "Rodriguez v. City of New York") but not a different defendant that merely starts alike
// ("… v. New York City Housing Authority" is not "… v. New York City Transit Authority"). A draft
// may shorten a retrieved name, not extend it: "Garcia v. Jones Lang LaSalle" is not "Garcia v.
// Jones". `lenient` lifts that last rule for a name in a title-case heading, where the words
// after it cannot be told from the rest of the heading.
function captionMatchesCase(captionParties, caseParties, { lenient = false } = {}) {
  if (!captionParties || !caseParties) return false;
  const { left: l, right: r } = captionParties;
  const { left: L, right: R } = caseParties;
  if (!tokensCompatible(l[l.length - 1], L[L.length - 1])) return false;
  const matched = alignDefendants(r, R);
  if (matched === -1) return false;
  return lenient || r.slice(matched).every(tok => ENTITY_SUFFIXES.has(tok.norm));
}

function buildPacket(retrievedCases) {
  const cases = [];
  // reporter key → [{ caseIndex, source, caption? }]. Usually one entry; two retrieved decisions
  // can start on the same page, and an excerpt can quote a citation another case owns.
  const reporterIndex = new Map();
  const looseParts = [];
  const quoted = [];                 // case names that appear in excerpts
  const snippets = [];

  const addHit = (key, hit) => {
    const hits = reporterIndex.get(key) || [];
    if (!hits.some(h => h.caseIndex === hit.caseIndex && h.source === hit.source)) hits.push(hit);
    reporterIndex.set(key, hits);
  };
  const index = (text, caseIndex) => {
    for (const rep of findReporters(matchable(text))) {
      if (rep.key) addHit(rep.key, { caseIndex, source: 'citation' });
    }
  };

  for (const entry of Array.isArray(retrievedCases) ? retrievedCases : []) {
    if (!entry) continue;
    const c = typeof entry === 'string' ? { caseName: entry } : entry;
    const name = String(c.caseName || c.case_name || c.name || '').trim();
    const citationStrings = [
      ...(Array.isArray(c.citations) ? c.citations : []),
      ...(Array.isArray(c.citation) ? c.citation : (c.citation ? [c.citation] : [])),
    ].map(String);
    const snippet = String(c.snippet || '');
    const url = String(c.url || c.absoluteUrl || c.absolute_url || '');
    const caseIndex = cases.length;

    cases.push({ name, url, parties: name ? splitParties(name) : null, looseName: ` ${looseText(name)} ` });

    for (const citation of citationStrings) index(citation, caseIndex);
    index(name, caseIndex);

    looseParts.push({ caseIndex, source: 'case_name', text: ` ${looseText(name)} ` });
    if (snippet) {
      looseParts.push({ caseIndex, source: 'snippet', text: ` ${looseText(snippet)} ` });
      snippets.push({ caseIndex, snippet });
    }
  }

  // Authorities quoted inside a retrieved excerpt were shown to the model, so they are part of
  // the packet — under the name the excerpt gives them, when it gives one. A citation that is a
  // retrieved case's own stays that case's: an excerpt that merely mentions it adds nothing.
  for (const { caseIndex, snippet } of snippets) {
    for (const item of citationsIn(snippet)) {
      if (item.caption) quoted.push({ caseIndex, parties: splitParties(item.caption) });
      for (const rep of item.reporters) {
        if (!rep.key || (reporterIndex.get(rep.key) || []).some(hit => hit.source === 'citation')) continue;
        addHit(rep.key, { caseIndex, source: 'snippet', caption: item.caption });
      }
    }
  }

  return { cases, reporterIndex, looseParts, quoted };
}

// Every place a reporter citation could sit in the packet. A pin cite ("150 A.D.3d at 702") fits
// any retrieved citation in that volume, and a slip opinion cited without its year any retrieved
// slip opinion with that number.
function findReporterInPacket(reporter, packet) {
  if (reporter.key) return packet.reporterIndex.get(reporter.key) || [];
  const found = [];
  for (const [key, hits] of packet.reporterIndex) {
    if (reporter.prefix ? key.startsWith(reporter.prefix) : key.endsWith(reporter.suffix)) found.push(...hits);
  }
  return found;
}

function captionRefersToCase(caption, packetCase, lenient = false) {
  if (captionMatchesCase(splitParties(caption), packetCase.parties, { lenient })) return true;
  const loose = looseText(caption);
  return Boolean(loose) && packetCase.looseName.includes(` ${loose} `);
}

// Is a draft caption the case a retrieved excerpt names next to a citation it quotes?
function captionRefersToQuotedCase(caption, quotedCaption) {
  if (captionMatchesCase(splitParties(caption), splitParties(quotedCaption))) return true;
  const loose = looseText(caption);
  return Boolean(loose) && ` ${looseText(quotedCaption)} `.includes(` ${loose} `);
}

function anchorCaption(caption, packet, lenient = false) {
  const parties = splitParties(caption);
  for (let i = 0; i < packet.cases.length; i++) {
    if (captionMatchesCase(parties, packet.cases[i].parties, { lenient })) return { caseIndex: i, source: 'case_name' };
  }
  for (const named of packet.quoted) {
    if (captionMatchesCase(parties, named.parties)) return { caseIndex: named.caseIndex, source: 'snippet' };
  }
  const loose = looseText(caption);
  if (loose) {
    for (const part of packet.looseParts) {
      if (part.text.includes(` ${loose} `)) return { caseIndex: part.caseIndex, source: part.source };
    }
  }
  return null;
}

// Does the text between a citation and a placeholder run into another sentence? A court-and-year
// parenthetical ("(N.Y. App. Div. 2019)") is part of the citation, so its periods do not count.
function crossesSentence(gap) {
  return SENTENCE_BREAK.test(gap.replace(/\([^)]*\)/g, ' '));
}

// Which citation occurrences carry a "[VERIFY CITATION Needed]" placeholder. Each placeholder is
// attributed to exactly one occurrence — the nearest citation it follows in the same sentence,
// otherwise the citation it directly precedes — so flagging one citation never excuses an
// unflagged neighbour, and a flag in the next sentence does not reach back.
// Returns a Set of "start:end" keys.
function placeholderFlaggedSpans(text, items) {
  const occurrences = items
    .flatMap(item => item.spans.map(([start, end]) => ({ start, end })))
    .sort((a, b) => a.start - b.start);
  const flagged = new Set();
  const re = new RegExp(PLACEHOLDER_SOURCE, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const placeholderStart = m.index;
    const placeholderEnd = m.index + m[0].length;

    let preceding = null;
    for (const occurrence of occurrences) {
      if (occurrence.end <= placeholderStart) preceding = occurrence;
    }
    if (preceding) {
      const gap = text.slice(preceding.end, placeholderStart);
      if (gap.length <= PLACEHOLDER_MAX_GAP_AFTER_CITATION && !crossesSentence(gap)) {
        flagged.add(`${preceding.start}:${preceding.end}`);
        continue;
      }
    }

    const following = occurrences.find(occurrence => occurrence.start >= placeholderEnd);
    if (following) {
      const gap = text.slice(placeholderEnd, following.start);
      if (gap.length <= PLACEHOLDER_MAX_GAP_BEFORE_CITATION && !crossesSentence(gap)) {
        flagged.add(`${following.start}:${following.end}`);
      }
    }
  }
  return flagged;
}

// Anchor a case name that comes with reporter citation(s). Every citation has to be in the packet,
// and one that the packet ties to a name has to be cited under that name: "Doe v. Roe" with
// another retrieved case's citation — its own, or one its excerpt quotes — is a misattribution,
// even though both halves are in the packet. Returns { anchor } or { reason }.
function anchorFullCitation(item, packet) {
  const lenient = item.inHeading;
  // Does the draft's case name agree with the name the packet gives this citation?
  // true / false, or null when the packet gives it no name (a bare citation in an excerpt).
  const agrees = hit => {
    if (hit.source === 'citation') return captionRefersToCase(item.caption, packet.cases[hit.caseIndex], lenient);
    return hit.caption ? captionRefersToQuotedCase(item.caption, hit.caption) : null;
  };

  let anchor = null;
  let unnamed = null;
  for (const reporter of item.reporters) {
    const hits = findReporterInPacket(reporter, packet);
    const named = hits.filter(hit => agrees(hit) !== null);
    const match = named.find(hit => agrees(hit) === true);
    if (named.length && !match) {
      const owner = named[0];
      return {
        reason: owner.source === 'citation'
          ? `Citation belongs to ${packet.cases[owner.caseIndex].name || 'another retrieved case'}, not to "${item.caption}"`
          : `Citation belongs to ${owner.caption} (quoted in a retrieved excerpt), not to "${item.caption}"`,
      };
    }
    if (match && (!anchor || (anchor.source !== 'citation' && match.source === 'citation'))) {
      anchor = { caseIndex: match.caseIndex, source: match.source };
    }
    if (!match && !unnamed) unnamed = { caseIndex: hits[0].caseIndex, source: hits[0].source };
  }
  if (anchor) return { anchor };
  // Only citations the packet gives no name to: the name itself has to be in the packet.
  if (anchorCaption(item.caption, packet, lenient)) return { anchor: unnamed };
  return { reason: `Case name "${item.caption}" does not match any case in the retrieved CourtListener packet` };
}

// Classify every citation in the draft. Internal items keep their spans for the repair helper.
function classifyCitations(draftText, retrievedCases) {
  const original = auditWindow(draftText);
  const text = matchable(original);
  const packet = buildPacket(retrievedCases);
  const items = collectCitations(text, original);
  const flaggedSpans = placeholderFlaggedSpans(text, items);

  return items.map(item => {
    let anchor = null;
    let reason = '';

    const missingReporters = item.reporters.filter(r => findReporterInPacket(r, packet).length === 0).map(r => r.text);

    if (missingReporters.length) {
      reason = `Reporter citation not in the retrieved CourtListener packet: ${missingReporters.join('; ')}`;
    } else if (item.caption && item.reporters.length) {
      ({ anchor = null, reason = '' } = anchorFullCitation(item, packet));
    } else if (item.caption && item.nameContinues) {
      reason = `The case name runs on past "${item.caption}", so it is not the retrieved case of that name`;
    } else if (item.caption) {
      anchor = anchorCaption(item.caption, packet, item.inHeading);
      if (!anchor) reason = `Case name not in the retrieved CourtListener packet: ${item.caption}`;
    } else {
      const [hit] = findReporterInPacket(item.reporters[0], packet);
      anchor = { caseIndex: hit.caseIndex, source: hit.source };
    }

    const spanFlags = item.spans.map(([start, end]) => flaggedSpans.has(`${start}:${end}`));
    let status;
    if (anchor) {
      status = 'ANCHORED';
      const matched = packet.cases[anchor.caseIndex];
      reason = anchor.source === 'snippet'
        ? `Quoted in the retrieved excerpt of ${matched?.name || 'a packet case'}`
        : `Matches retrieved CourtListener case ${matched?.name || ''}`.trim();
    } else if (spanFlags.every(Boolean)) {
      status = 'PLACEHOLDER_FLAGGED';
      reason = `${reason}. Marked ${VERIFY_PLACEHOLDER} by the author`;
    } else {
      status = 'UNANCHORED';
    }

    const matchedCase = anchor ? packet.cases[anchor.caseIndex] : null;
    return {
      ...item,
      spanFlags,
      status,
      reason,
      anchor_source: anchor ? anchor.source : null,
      matched_case: matchedCase?.name || null,
      matched_case_url: matchedCase?.url || null,
    };
  });
}

// ─── CourtListener citation-lookup enrichment ──────────────────────────────────

function courtListenerToken() {
  const token = String(process.env.COURTLISTENER_TOKEN || '').trim();
  if (!token) return null;
  if (/^(?:your[-_]|optional[-_]|replace[-_]|insert[-_])/i.test(token)) return null;
  return token;
}

/**
 * Convert a citation-lookup API payload into Map(reporterKey → { status, url, caseName }).
 * Per-citation `status`: 200 found · 300 ambiguous (several clusters) · 404 not found ·
 * 400 not a valid reporter · 429 too many citations in one request.
 */
export function mapCitationLookupResponse(payload) {
  const results = new Map();
  if (!Array.isArray(payload)) return results;

  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue;
    const clusters = Array.isArray(entry.clusters) ? entry.clusters : [];
    let outcome;
    if ((entry.status === 200 || entry.status === 300) && clusters.length > 0) {
      const abs = clusters[0].absolute_url;
      outcome = {
        status: 'VERIFIED',
        url: typeof abs === 'string' && abs.startsWith('/') ? `https://www.courtlistener.com${abs}` : null,
        caseName: typeof clusters[0].case_name === 'string' ? clusters[0].case_name : null,
      };
    } else if (entry.status === 404) {
      outcome = { status: 'NOT_FOUND_404', url: null, caseName: null };
    } else {
      outcome = { status: 'UNCHECKED', url: null, caseName: null };
    }

    const forms = [entry.citation, ...(Array.isArray(entry.normalized_citations) ? entry.normalized_citations : [])];
    for (const form of forms) {
      for (const rep of findReporters(matchable(form))) {
        if (rep.key && !results.has(rep.key)) results.set(rep.key, outcome);
      }
    }
  }
  return results;
}

// One batched POST for every reporter citation. Never throws; anything short of a per-citation
// answer (throttling, timeout, outage) leaves the citation UNCHECKED rather than "not found".
async function lookupReporters(reporterTexts, token, fetchImpl) {
  try {
    const res = await fetchImpl(CL_CITATION_LOOKUP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'NYCInjuryAI-Citator/1.0',
      },
      body: new URLSearchParams({ text: reporterTexts.join('\n') }).toString(),
      signal: AbortSignal.timeout(CL_LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[Citator] CourtListener citation-lookup unavailable (HTTP ${res.status}); citations left UNCHECKED`);
      return new Map();
    }
    return mapCitationLookupResponse(await res.json());
  } catch (err) {
    console.warn(`[Citator] CourtListener citation-lookup failed: ${err.message}; citations left UNCHECKED`);
    return new Map();
  }
}

// ─── Public audit API ──────────────────────────────────────────────────────────

/**
 * Audit every case citation in a draft against the retrieved CourtListener cases.
 *
 * @param {string} draftText
 * @param {Array<{caseName?: string, citation?: string, citations?: string[], snippet?: string, url?: string}>} retrievedCases
 * @param {{enableCourtListener?: boolean, fetchImpl?: Function, lookupCache?: Map}} [options]
 *   enableCourtListener — also check non-anchored reporter citations against CourtListener's
 *   citation-lookup API. Only runs when COURTLISTENER_TOKEN is set and NODE_ENV !== 'test'
 *   (an injected fetchImpl is not network access, so it is honoured in tests).
 *   lookupCache — a Map the caller keeps between audits of successive versions of one reply. What
 *   CourtListener said about a citation is remembered there, so it is not asked twice and a later
 *   lookup that is throttled cannot turn "no such citation" back into "not checked".
 * @returns {Promise<Array<{citation_text: string, kind: string, status: 'ANCHORED'|'PLACEHOLDER_FLAGGED'|'UNANCHORED', reason: string, courtlistener_status: 'VERIFIED'|'NOT_FOUND_404'|'UNCHECKED', courtlistener_url: string|null}>>}
 */
export async function auditDraftCitations(draftText, retrievedCases = [], { enableCourtListener = false, fetchImpl, lookupCache } = {}) {
  const classified = classifyCitations(draftText, retrievedCases);
  const lookups = lookupCache instanceof Map ? lookupCache : new Map();

  // Anchored citations came out of CourtListener in the first place, so the lookup budget is
  // spent only on the ones that did not. A citation without a first page (a pin cite, a slip
  // opinion without its year) cannot be looked up.
  const lookupable = item => item.reporters.filter(r => !r.short);
  const pending = [...new Set(
    classified
      .filter(item => item.status !== 'ANCHORED')
      .flatMap(item => lookupable(item).filter(r => !lookups.has(r.key)).map(r => r.text))
  )];
  const token = courtListenerToken();
  const injected = typeof fetchImpl === 'function';
  const canLookUp = enableCourtListener && token && pending.length > 0 &&
    (process.env.NODE_ENV !== 'test' || injected);

  if (canLookUp) {
    const answers = await lookupReporters(pending, token, injected ? fetchImpl : fetch);
    // Only a definite answer is kept; anything else is asked again next time.
    for (const [key, outcome] of answers) {
      if (outcome.status !== 'UNCHECKED') lookups.set(key, outcome);
    }
  }

  return classified.map(item => {
    const audit = {
      citation_text: item.citation_text,
      kind: item.kind,
      status: item.status,
      reason: item.reason,
      courtlistener_status: 'UNCHECKED',
      courtlistener_url: null,
    };

    if (item.matched_case) {
      audit.matched_case = item.matched_case;
      audit.anchor_source = item.anchor_source;
      if (item.matched_case_url) audit.matched_case_url = item.matched_case_url;
    }

    const checked = lookupable(item);
    const outcomes = checked.map(r => lookups.get(r.key)).filter(Boolean);
    if (outcomes.length) {
      if (outcomes.some(o => o.status === 'NOT_FOUND_404')) {
        audit.courtlistener_status = 'NOT_FOUND_404';
      } else if (outcomes.length === checked.length && outcomes.every(o => o.status === 'VERIFIED')) {
        audit.courtlistener_status = 'VERIFIED';
        audit.courtlistener_url = outcomes[0].url;
        if (outcomes[0].caseName) audit.courtlistener_case_name = outcomes[0].caseName;
      }
    }
    return audit;
  });
}

// Where the flag for a citation that ends at `end` is inserted: after its possessive, the markers
// that close a run of bold or italic text, a Markdown link target and the court-and-year note, so
// that it lands inside none of them. Null when the flag would fall outside the part of the text
// that is audited, where it could not be seen on the next pass.
function flagPosition(text, end) {
  let at = end;
  const skip = pattern => {
    const m = pattern.exec(text.slice(at, at + 200));
    if (m) at += m[0].length;
  };
  skip(/^['’]s(?![\p{L}\p{N}])/u);                 // Macy's, Carrier's
  skip(/^[*_`]+/);                                 // **name**, _name_
  skip(/^\]\([^)\s]{0,180}\)/);                    // [name](https://…)
  skip(/^[*_`]+/);
  skip(/^\s*\((?:[^()\n]{0,40}\s)?\d{4}\)/);       // (2019), (N.Y. App. Div. 2019), (1st Dept 2018)
  skip(/^\s*\[[^\]\n]{0,30}\d{4}\]\)?/);           // official style: (12 NY3d 345 [2009])
  return at + VERIFY_PLACEHOLDER.length + 2 > MAX_AUDIT_CHARS ? null : at;
}

/**
 * Deterministic repair: append "[VERIFY CITATION Needed]" after every occurrence of a citation
 * that is not anchored in the retrieved packet and does not carry the flag already. Returns the
 * new text and the citations flagged.
 */
export function flagUnanchoredCitations(draftText, retrievedCases = []) {
  const text = String(draftText ?? '');
  const unanchored = classifyCitations(text, retrievedCases).filter(item => item.status === 'UNANCHORED');

  const positions = new Set();
  const flagged = [];
  for (const item of unanchored) {
    let added = false;
    item.spans.forEach(([, end], i) => {
      if (item.spanFlags[i]) return;
      const at = flagPosition(text, end);
      if (at === null) return;
      positions.add(at);
      added = true;
    });
    if (added) flagged.push(item.citation_text);
  }
  if (!positions.size) return { text, flagged: [] };

  // One pass over the text, so the cost does not grow with the number of flags.
  const parts = [];
  let cursor = 0;
  for (const at of [...positions].sort((a, b) => a - b)) {
    parts.push(text.slice(cursor, at), ` ${VERIFY_PLACEHOLDER}`);
    cursor = at;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(''), flagged };
}
