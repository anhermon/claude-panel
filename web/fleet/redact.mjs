// Secret masking for every transcript text the fleet keeps or shows (titles, prompts, assistant text, commands, tool output).
// The page shows real conversation text, so this is the one gate: nothing reaches state.json or the page without passing
// through here. Twin of the shapes in hooks/transcript-redact.ts (scrubText), extended with whole `Authorization:`-style
// header lines and long mixed blobs; unlike scrubText it KEEPS newlines (a readable drill-down needs them).
// Best effort pattern matching, not a proof: a secret without a recognisable shape (a bare password in prose) is not caught.
// Pure: no I/O.

export const REDACTED = '[redacted]';
export const ELLIPSIS = '…';
const MIN_BLOB = 40;

// Shapes of secrets; each replaces its own match, in this order.
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
const HEADER_LINE = /\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)(\s*:\s*)[^\r\n]+/gi;
const URL_USERINFO = /(:\/\/)[^/\s:@]+:[^/\s@]+@/g;
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const NAMED_SECRET = /\b([A-Za-z0-9_.-]*(?:token(?!s)|secret|passw(?:or)?d|passwd|api[_-]?key|apikey|auth(?!or)|credential|private[_-]?key)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&|)]+)/gi;
const SECRET_FLAG = /(--?(?:token|password|passwd|pass|secret|api-?key|auth|key)\b)(\s+|=)(?!-)("[^"\n]*"|'[^'\n]*'|\S+)/gi;
const TOKEN_SHAPES =
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g;
const LONG_BLOB = new RegExp(`[A-Za-z0-9_+/=-]{${MIN_BLOB},}`, 'g');
const HAS_DIGIT = /\d/;
const HAS_LETTER = /[A-Za-z]/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** A path-like or all-letter run is not a secret; a long run mixing letters and digits is treated as one. */
const maskBlob = (run) => (HAS_DIGIT.test(run) && HAS_LETTER.test(run) && !run.includes('/') ? REDACTED : run);

/** Text with secrets replaced; newlines and everything else kept. Non-strings give ''. */
export function maskSecrets(text) {
  if (typeof text !== 'string' || text === '') return '';
  return text
    .replace(CONTROL_CHARS, ' ')
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(HEADER_LINE, `$1$2${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(AUTH_SCHEME, `$1 ${REDACTED}`)
    .replace(NAMED_SECRET, `$1$2${REDACTED}`)
    .replace(SECRET_FLAG, `$1$2${REDACTED}`)
    .replace(TOKEN_SHAPES, REDACTED)
    .replace(LONG_BLOB, maskBlob);
}

/** `max` characters with a trailing ellipsis when cut. */
export function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}${ELLIPSIS}`;
}

/** Masked, whitespace collapsed to one line, cut: for titles, prompts and labels. */
export const oneLine = (text, max) => clip(maskSecrets(text).replace(/\s+/g, ' ').trim(), max);

/** Masked and cut but multi-line (drill-down bodies). */
export const block = (text, max) => clip(maskSecrets(text).replace(/\r\n?/g, '\n').trim(), max);
