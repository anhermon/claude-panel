// Kind of work of one tool call (ui, logic, tests, visual, docs, research, reading, delegating, working), for the
// drill-down's "kind of work" breakdown. A port of hooks/work-kinds.ts (kindOf, fileKind) and the target rules of
// hooks/pulse-redact.ts (basename, first Bash word + verb, zone): the page process is plain Node and cannot import the
// mod's TypeScript. The labels and colours come from web/builtin/board/kind-meta.mjs, so the board and the fleet agree.
// Pure: no I/O.
export { KIND_META } from '../builtin/board/kind-meta.mjs';

const EDIT_TOOLS = ['Edit', 'MultiEdit', 'NotebookEdit', 'Write'];
const READ_TOOLS = ['Read', 'NotebookRead'];
const SEARCH_TOOLS = ['Grep', 'Glob', 'LS'];
const WEB_TOOLS = ['WebSearch', 'WebFetch'];
const DELEGATE_TOOLS = ['Agent', 'Task', 'SendMessage', 'spawn'];
const VISUAL_PREFIXES = ['mcp__claude-in-chrome__', 'mcp__panel__scene'];
const IGNORED_TOOLS = ['lane', 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];
const IGNORED_PREFIXES = ['mcp__savvy-progress__', 'mcp__panel__panel'];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const DOC_EXTS = ['md', 'mdx', 'rst', 'txt'];
const DOC_NAMES = ['skill', 'readme', 'changelog'];
const UI_EXTS = ['html', 'htm', 'css', 'scss', 'svg', 'tsx', 'jsx', 'vue', 'svelte'];
const SCRIPT_EXTS = ['js', 'mjs', 'cjs', 'ts', 'mts'];
const LOGIC_EXTS = ['ts', 'mts', 'js', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'rb', 'sh', 'php', 'c', 'cc', 'cpp', 'h', 'cs', 'lua', 'sql'];
const TEST_NAME = /(?:\.(?:test|spec)\.[a-z0-9]+$)|(?:^test_[^.]+\.py$)|(?:_test\.(?:go|py)$)/;
const TEST_DIRS = ['tests', 'test', '__tests__', 'spec', 'specs', 'e2e', 'evals'];
const UI_DIRS = ['web', 'public', 'static', 'components', 'ui', 'styles', 'css', 'frontend', 'client', 'pages'];
const TEST_VERBS = ['test', 'tests', 'lint', 'typecheck', 'check'];
const BASH_VERBS = ['test', 'tests', 'build', 'lint', 'typecheck', 'check'];
const CHECK_PROGRAMS = ['tsc', 'vitest', 'jest', 'pytest', 'mocha', 'playwright', 'cypress', 'eslint', 'mypy', 'ruff'];
const RENDER_WORDS = ['render', 'screenshot', 'shot', 'screencap', 'screencapture', 'chrome', 'chromium'];
const LOOKER_PROGRAMS = ['cat', 'sed', 'grep', 'rg', 'head', 'tail', 'ls', 'find', 'wc', 'awk', 'jq', 'sort', 'file', 'stat', 'diff', 'tree', 'du', 'less', 'nl', 'cut', 'uniq', 'xxd', 'pwd', 'which', 'tr', 'column', 'fd'];
const SCRIPT_RUNNERS = ['node', 'bun', 'deno', 'python', 'python3', 'tsx', 'npx'];
const FILE_KEYS = ['file_path', 'notebook_path', 'path'];
const WORD_SPLIT = /[^a-z0-9]+/;
const PATH_SEP = /[\\/]+/;
const LEADING_CD = /^cd(?:\s+[^;&|]*)?\s*(?:&&|;|\|\|)\s*/;
const LEADING_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
const PROGRAM_NAME = /^[A-Za-z0-9._+@-]{1,32}$/;
const VERB_SCAN_WORDS = 4;
const MAX_SKIPPED = 8;
const NAME_MAX = 60;

const has = (list, v) => list.includes(v);
const wordsOf = (s) => s.toLowerCase().split(WORD_SPLIT).filter(Boolean);
const extOf = (name) => { const at = name.lastIndexOf('.'); return at <= 0 ? '' : name.slice(at + 1).toLowerCase(); };

export function baseName(p) {
  if (typeof p !== 'string') return '';
  const parts = p.split(PATH_SEP).filter(Boolean);
  return (parts[parts.length - 1] ?? '').slice(0, NAME_MAX);
}

function realCommand(command) {
  let rest = command.trim();
  for (let i = 0; i < MAX_SKIPPED; i++) {
    const next = rest.replace(LEADING_ASSIGN, '').replace(LEADING_CD, '');
    if (next === rest || next === '') break;
    rest = next;
  }
  return rest;
}

function bashTarget(command) {
  if (typeof command !== 'string') return '';
  const words = realCommand(command).split(/\s+/);
  const word = words.find((w) => w !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const program = baseName((word ?? '').replace(/^["'`({]+/, ''));
  if (!PROGRAM_NAME.test(program)) return '';
  const args = (realCommand(command).split(/[;&|\n]/)[0] ?? '').trim().split(/\s+/).slice(1, 1 + VERB_SCAN_WORDS);
  const verb = args.map((w) => w.replace(/^-+/, '').toLowerCase()).find((w) => has(BASH_VERBS, w));
  if (verb) return `${program} ${verb}`;
  if (has(SCRIPT_RUNNERS, program)) {
    const script = baseName(args.find((w) => w !== '' && !w.startsWith('-')) ?? '').toLowerCase();
    if (wordsOf(script).some((w) => has(RENDER_WORDS, w))) return `${program} render`;
  }
  return program;
}

function zoneOf(tool, input) {
  if (!has(EDIT_TOOLS, tool) && !has(READ_TOOLS, tool) && !has(SEARCH_TOOLS, tool)) return '';
  const p = FILE_KEYS.map((k) => input[k]).find((v) => typeof v === 'string' && v !== '');
  if (p === undefined) return '';
  const dirs = p.split(PATH_SEP).slice(0, -1).map((d) => d.toLowerCase());
  if (dirs.some((d) => has(TEST_DIRS, d))) return 'tests';
  return dirs.some((d) => has(UI_DIRS, d)) ? 'ui' : '';
}

/** The short target of a call: a file's basename, a program (+ verb), '' otherwise. */
export function targetOf(tool, input) {
  if (tool === 'Bash') return bashTarget(input.command);
  for (const k of FILE_KEYS) { const n = baseName(input[k]); if (n !== '') return n; }
  return '';
}

function fileKind(name, zone) {
  const ext = extOf(name);
  const lower = name.toLowerCase();
  if (TEST_NAME.test(lower) || (zone === 'tests' && has(LOGIC_EXTS, ext))) return 'tests';
  if (has(DOC_EXTS, ext) || has(DOC_NAMES, lower.split('.')[0] ?? '')) return 'docs';
  if (has(UI_EXTS, ext) || (zone === 'ui' && has(SCRIPT_EXTS, ext))) return 'ui';
  return has(LOGIC_EXTS, ext) ? 'logic' : 'working';
}

function bashKind(target) {
  const [program = '', verb = ''] = target.split(' ');
  if (verb === 'render' || wordsOf(program).some((w) => has(RENDER_WORDS, w))) return 'visual';
  if (has(TEST_VERBS, verb) || has(CHECK_PROGRAMS, program)) return 'tests';
  return has(LOOKER_PROGRAMS, program) ? 'reading' : 'working';
}

/** The kind of one tool call (name + raw input), or undefined for bookkeeping tools. Unknown tools are `working`. */
export function kindOfCall(tool, input = {}) {
  if (has(IGNORED_TOOLS, tool) || IGNORED_PREFIXES.some((p) => tool.startsWith(p))) return undefined;
  const target = targetOf(tool, input);
  if (has(DELEGATE_TOOLS, tool)) return 'delegating';
  if (has(WEB_TOOLS, tool)) return 'research';
  if (VISUAL_PREFIXES.some((p) => tool.startsWith(p))) return 'visual';
  if (has(EDIT_TOOLS, tool)) return fileKind(target, zoneOf(tool, input));
  if (has(READ_TOOLS, tool)) return has(IMAGE_EXTS, extOf(target)) ? 'visual' : 'reading';
  if (has(SEARCH_TOOLS, tool)) return 'reading';
  if (tool === 'Bash') return bashKind(target);
  return 'working';
}
