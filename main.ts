// mend — one patch tool for every AI edit format.
//
// Reads a patch on stdin (or from a file) in one of four formats
// (unified diff, SEARCH/REPLACE, V4A, JSON tool calls) and applies it
// to the files in the current directory, all or nothing.
//
// Usage: node main.ts [--format=<unified|search-replace|v4a|json|auto>]
//                     [--check] [--strict] [PATCH | -]
//   PATCH omitted or "-" reads stdin. Exit codes: 0 ok, 1 edit failed,
//   2 usage / no-patch / format / parse error.
//
// See SPEC.md for the full specification this implements.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Trial mode is dispatched at the end of this file, after every
// declaration, so class declarations are initialized before main() runs.

// ---------------------------------------------------------------- types

type FailCode = 'no-match' | 'ambiguous' | 'missing' | 'exists' | 'unsafe';

interface EditFailure {
  code: FailCode;
  path: string;
}

type EditResult = { ok: true } | { ok: false; fail: EditFailure };

function fail(code: FailCode, path: string): EditResult {
  return { ok: false, fail: { code, path } };
}

const OK: EditResult = { ok: true };

interface BodyLine {
  t: 'ctx' | 'old' | 'new' | 'backslash';
  text: string;
}

interface Hunk {
  a: number; // old start line (1-based) from the @@ header
  body: BodyLine[];
  noEol: boolean; // a `\` line follows the hunk's last context or `+` line
}

interface VChunk {
  anchor: string | null;
  body: BodyLine[]; // ctx / old / new only
  eof: boolean;
}

type Edit =
  | { kind: 'noop' }
  | { kind: 'unified'; oldPath: string | null; newPath: string | null; mode: 'create' | 'delete' | 'move' | 'change'; hunks: Hunk[] }
  | { kind: 'search-replace'; path: string; oldLines: string[]; newLines: string[] }
  | { kind: 'v4a-add'; path: string; lines: string[] }
  | { kind: 'v4a-delete'; path: string }
  | { kind: 'v4a-update'; path: string; moveTo: string | null; chunks: VChunk[] }
  | { kind: 'json-create'; path: string; fileText: string }
  | { kind: 'json-str-replace'; path: string; oldStr: string; newStr: string }
  | { kind: 'json-insert'; path: string; insertLine: number; newStr: string };

class ParseFault extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

// ------------------------------------------------------- small utilities

function isBlank(s: string): boolean {
  return /^\s*$/.test(s);
}

function trimWs(s: string): string {
  return s.replace(/^\s+/, '').replace(/\s+$/, '');
}

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

// The patch's lines: split at \n, one trailing \r removed from each,
// and no empty piece after a final \n.
function patchLines(text: string): string[] {
  const raw = text.split('\n');
  if (text.endsWith('\n')) raw.pop();
  return raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// A file's lines with its line-break style and whether it ends in one.
interface FileLines {
  lines: string[];
  br: string;
  eol: boolean;
}

function parseFileLines(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const firstLf = text.indexOf('\n');
  const br = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let eol = false;
  if (text.endsWith(br)) {
    parts.pop();
    eol = true;
  }
  return { lines: parts, br, eol };
}

function joinFileLines(lines: string[], br: string, eol: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (eol ? br : '');
}

// Lines of a string written as patch text (e.g. JSON new_str): split at
// \n, one trailing \r removed, no empty piece after a final \n.
function splitTextLines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ------------------------------------------------------------ file tree

interface FileState {
  exists: boolean;
  text: string;
  origExists: boolean;
  origText: string;
}

class Tree {
  private m = new Map<string, FileState>();

  get(path: string): FileState {
    let e = this.m.get(path);
    if (!e) {
      let exists = false;
      let text = '';
      try {
        if (existsSync(path) && statSync(path).isFile()) {
          text = readFileSync(path, 'utf8');
          exists = true;
        }
      } catch {
        exists = false;
        text = '';
      }
      e = { exists, text, origExists: exists, origText: text };
      this.m.set(path, e);
    }
    return e;
  }

  set(path: string, text: string): void {
    const e = this.get(path);
    e.exists = true;
    e.text = text;
  }

  delete(path: string): void {
    const e = this.get(path);
    e.exists = false;
    e.text = '';
  }

  entries(): IterableIterator<[string, FileState]> {
    return this.m.entries();
  }
}

// ------------------------------------------------------------- matching

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

function findOccurrences(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const start = Math.max(0, from);
  for (let i = start; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(fileLines[i + j], o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// First tier (0..2, or only 0 when strict) with an occurrence at/after
// `from`, together with that tier's occurrences.
function findTier(
  fileLines: string[],
  o: string[],
  from: number,
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occ = findOccurrences(fileLines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

// Re-indent a line of N at tier 2: a line that starts with P (the
// leading whitespace of O's first line) has P replaced with F (the
// leading whitespace of the file's first matched line). When P is
// empty, every line starts with it, so F is prepended.
function reindent(line: string, f: string, p: string): string {
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

interface NLine {
  text: string;
  ctx: boolean; // a context line: written as the file's own matched line
  oIdx: number; // index into O for context lines, -1 otherwise
}

// Build the replacement lines for an occurrence of O at `start`.
function buildReplacement(fileLines: string[], start: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  const f = tier === 2 ? leadingWs(fileLines[start] ?? '') : '';
  const p = tier === 2 ? leadingWs(o[0] ?? '') : '';
  for (const nl of n) {
    if (nl.ctx) {
      out.push(fileLines[start + nl.oIdx]);
    } else if (tier === 2) {
      out.push(reindent(nl.text, f, p));
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

// Split a hunk/chunk body into its old lines O and its new lines N.
function splitBody(body: BodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.t === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oIdx: o.length - 1 });
    } else if (b.t === 'old') {
      o.push(b.text);
    } else if (b.t === 'new') {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
    }
    // backslash lines are not part of O or N
  }
  return { o, n };
}

// ----------------------------------------------------------- arg parsing

interface Args {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): Args | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const positional: string[] = [];
  let afterDashDash = false;
  for (const a of argv) {
    if (!afterDashDash && a === '--') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return null;
        format = v;
      } else {
        return null;
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return null;
  return { format: format ?? 'auto', check, strict, patch: positional.length === 1 ? positional[0] : null };
}

// ---------------------------------------------------------- format detect

function detectFormat(lines: string[]): string | null {
  let first: string | null = null;
  for (const l of lines) {
    if (!isBlank(l)) {
      first = l;
      break;
    }
  }
  if (first === null) return null;
  if (trimWs(first) === '*** Begin Patch') return 'v4a';
  const firstNonWs = first.replace(/^\s+/, '');
  if (firstNonWs.startsWith('[') || firstNonWs.startsWith('{')) return 'json';
  for (const l of lines) {
    if (trimEndWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// -------------------------------------------------------- unified parsing

function parseDiffPath(line: string): string {
  // line starts with '--- ' or '+++ '
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunk(lines: string[], start: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[start]);
  if (!m) throw new ParseFault(start + 1);
  const a = parseInt(m[1], 10);
  const body: BodyLine[] = [];
  let j = start + 1;
  while (j < lines.length) {
    const l = lines[j];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
    if (l === '') {
      body.push({ t: 'ctx', text: '' });
      j++;
      continue;
    }
    const c = l[0];
    if (c === ' ') {
      body.push({ t: 'ctx', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '-') {
      body.push({ t: 'old', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '+') {
      body.push({ t: 'new', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '\\') {
      body.push({ t: 'backslash', text: l });
      j++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0) {
    const last = body[body.length - 1];
    if (last.t === 'ctx' && last.text === '') body.pop();
    else break;
  }
  // A `\` line follows the hunk's last context or `+` line.
  let noEol = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k];
    if (b.t === 'ctx' || b.t === 'new') {
      if (k + 1 < body.length && body[k + 1].t === 'backslash') noEol = true;
      break;
    }
  }
  return { hunk: { a, body, noEol }, next: j };
}

function parseUnifiedSection(
  lines: string[],
  start: number,
  gitOld: string | null,
  gitNew: string | null,
): { edit: Edit; next: number } {
  const n = lines.length;
  let i = start;
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let isCreate = false;
  let isDelete = false;
  let havePair = false;
  const hunks: Hunk[] = [];
  let inHeader = true;

  if (lines[i].startsWith('diff --git ')) i++;

  while (i < n) {
    const line = lines[i];
    if (inHeader) {
      if (line.startsWith('diff --git ')) break; // a new section starts
      if (line.startsWith('--- ')) {
        if (havePair) {
          if (i + 1 < n && lines[i + 1].startsWith('+++ ')) break; // new section
          throw new ParseFault(i + 2);
        }
        if (i + 1 >= n || !lines[i + 1].startsWith('+++ ')) throw new ParseFault(i + 2);
        oldPath = parseDiffPath(line);
        newPath = parseDiffPath(lines[i + 1]);
        havePair = true;
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) {
        newPath = parseDiffPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        renameFrom = trimWs(line.slice('rename from '.length));
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        renameTo = trimWs(line.slice('rename to '.length));
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        isDelete = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const h = parseHunk(lines, i);
        hunks.push(h.hunk);
        i = h.next;
        inHeader = false;
        continue;
      }
      i++; // other header lines are ignored
      continue;
    }
    // After the first hunk: next hunk, a new section, or ignored prose.
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) break;
    if (line.startsWith('@@')) {
      const h = parseHunk(lines, i);
      hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    i++;
  }

  const oldP = oldPath ?? renameFrom ?? gitOld;
  const newP = newPath ?? renameTo ?? gitNew;
  const oldIsNull = oldP === null || oldP === '/dev/null';
  const newIsNull = newP === null || newP === '/dev/null';

  if (oldIsNull && newIsNull) {
    return { edit: { kind: 'noop' }, next: i };
  }
  if (oldIsNull || isCreate) {
    return { edit: { kind: 'unified', oldPath: null, newPath: newP, mode: 'create', hunks }, next: i };
  }
  if (newIsNull || isDelete) {
    return { edit: { kind: 'unified', oldPath: oldP, newPath: null, mode: 'delete', hunks }, next: i };
  }
  if (oldP !== newP) {
    return { edit: { kind: 'unified', oldPath: oldP, newPath: newP, mode: 'move', hunks }, next: i };
  }
  return { edit: { kind: 'unified', oldPath: oldP, newPath: newP, mode: 'change', hunks }, next: i };
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new ParseFault(i + 1);
      const gitOld = m[1].replace(/[ \t]+$/, '');
      const gitNew = m[2].replace(/[ \t]+$/, '');
      if (gitOld === '' || gitNew === '') throw new ParseFault(i + 1);
      const sec = parseUnifiedSection(lines, i, gitOld, gitNew);
      edits.push(sec.edit);
      i = sec.next;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      const sec = parseUnifiedSection(lines, i, null, null);
      edits.push(sec.edit);
      i = sec.next;
      continue;
    }
    if (line.startsWith('@@')) throw new ParseFault(i + 1);
    i++;
  }
  return edits;
}

// -------------------------------------------------- search-replace parsing

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevPath: string | null = null;
  let prevReplace = -1; // index of the previous block's REPLACE line
  while (i < n) {
    if (trimEndWs(lines[i]) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    // Path: nearest non-blank line before SEARCH, after the previous
    // block's REPLACE line, not starting with ``` (fence lines skipped).
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplace; j--) {
      const l = lines[j];
      if (isBlank(l)) continue;
      const t = trimWs(l);
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(searchLine + 1);
      path = prevPath;
    }
    // Find the separator; a REPLACE line first means the SEARCH line
    // has no separator.
    let sep = -1;
    let j = searchLine + 1;
    while (j < n) {
      const t = trimEndWs(lines[j]);
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') throw new ParseFault(searchLine + 1);
      j++;
    }
    if (sep === -1) throw new ParseFault(searchLine + 1);
    let rep = -1;
    j = sep + 1;
    while (j < n) {
      if (trimEndWs(lines[j]) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      j++;
    }
    if (rep === -1) throw new ParseFault(searchLine + 1);
    edits.push({
      kind: 'search-replace',
      path,
      oldLines: lines.slice(searchLine + 1, sep),
      newLines: lines.slice(sep + 1, rep),
    });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

// ----------------------------------------------------------- V4A parsing

function trimChunkTail(chunk: VChunk): void {
  while (chunk.body.length > 0) {
    const last = chunk.body[chunk.body.length - 1];
    if (last.t === 'ctx' && last.text === '') chunk.body.pop();
    else break;
  }
}

function parseVBodyLine(l: string): BodyLine {
  if (l === '') return { t: 'ctx', text: '' };
  const c = l[0];
  if (c === ' ') return { t: 'ctx', text: l.slice(1) };
  if (c === '-') return { t: 'old', text: l.slice(1) };
  if (c === '+') return { t: 'new', text: l.slice(1) };
  throw new ParseFault(-1); // caller replaces with the real line number
}

function isSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function parseV4a(lines: string[]): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseFault(1);
  if (trimWs(lines[first]) !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (trimWs(lines[last]) !== '*** End Patch') throw new ParseFault(n + 1);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = trimWs(line.slice('*** Add File: '.length));
      i++;
      // Collect the section's lines, then drop blank lines at its end
      // (they are not part of it) before checking their shape: each
      // remaining line starts with `+` or is empty. A whitespace-only
      // line in the middle is neither, so it is a parse error.
      const secStart = i;
      const secLines: string[] = [];
      while (i < last) {
        const l = lines[i];
        if (isSectionStart(l)) break;
        secLines.push(l);
        i++;
      }
      while (secLines.length > 0 && isBlank(secLines[secLines.length - 1])) secLines.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < secLines.length; k++) {
        const l = secLines[k];
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new ParseFault(secStart + k + 1);
      }
      edits.push({ kind: 'v4a-add', path, lines: fileLines });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = trimWs(line.slice('*** Delete File: '.length));
      i++;
      while (i < last) {
        const l = lines[i];
        if (isSectionStart(l)) break;
        if (isBlank(l)) {
          i++;
          continue;
        }
        throw new ParseFault(i + 1);
      }
      edits.push({ kind: 'v4a-delete', path });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const updateLine = i;
      const path = trimWs(line.slice('*** Update File: '.length));
      i++;
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunkStarted = false;
      const pushChunk = (trimTail: boolean) => {
        if (!cur) return;
        if (trimTail) trimChunkTail(cur);
        chunks.push(cur);
        cur = null;
      };
      while (i < last) {
        const l = lines[i];
        if (isSectionStart(l)) break;
        if (!firstChunkStarted && moveTo === null && l.startsWith('*** Move to: ')) {
          moveTo = trimWs(l.slice('*** Move to: '.length));
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          pushChunk(false);
          cur = { anchor: trimWs(l.slice(2)) || null, body: [], eof: false };
          firstChunkStarted = true;
          i++;
          continue;
        }
        if (trimEndWs(l) === '*** End of File') {
          if (!cur) throw new ParseFault(i + 1);
          cur.eof = true;
          pushChunk(false);
          i++;
          continue;
        }
        if (l.startsWith('*** ')) throw new ParseFault(i + 1);
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (!cur) {
            if (firstChunkStarted) throw new ParseFault(i + 1);
            cur = { anchor: null, body: [], eof: false };
            firstChunkStarted = true;
          }
          cur.body.push(parseVBodyLine(l));
          i++;
          continue;
        }
        if (isBlank(l)) {
          if (cur) cur.body.push({ t: 'ctx', text: '' });
          i++;
          continue;
        }
        throw new ParseFault(i + 1);
      }
      pushChunk(true);
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(updateLine + 1);
      edits.push({ kind: 'v4a-update', path, moveTo, chunks });
      continue;
    }
    throw new ParseFault(i + 1);
  }
  return edits;
}

// ------------------------------------------------------------ JSON parsing

function validateJsonEdit(v: unknown): Edit | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  const path = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { kind: 'json-create', path, fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str === undefined) return { kind: 'json-str-replace', path, oldStr: o.old_str, newStr: '' };
    if (typeof o.new_str !== 'string') return null;
    return { kind: 'json-str-replace', path, oldStr: o.old_str, newStr: o.new_str };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { kind: 'json-insert', path, insertLine: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function parseJson(lines: string[], patchText: string): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseFault(1);
  const firstChar = lines[first].replace(/^\s+/, '')[0];
  if (firstChar === '[') {
    // Array form: the whole patch is one JSON array.
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(arr)) throw new ParseFault(first + 1);
    const edits: Edit[] = [];
    for (const el of arr) {
      const e = validateJsonEdit(el);
      if (!e) throw new ParseFault(first + 1);
      edits.push(e);
    }
    return edits;
  }
  // JSON Lines form: one edit object per non-blank line.
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isBlank(l)) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new ParseFault(i + 1);
    }
    const e = validateJsonEdit(obj);
    if (!e) throw new ParseFault(i + 1);
    edits.push(e);
  }
  return edits;
}

// --------------------------------------------------------- patch dispatch

function parsePatch(format: string, lines: string[], patchText: string): Edit[] {
  switch (format) {
    case 'unified':
      return parseUnified(lines);
    case 'search-replace':
      return parseSearchReplace(lines);
    case 'v4a':
      return parseV4a(lines);
    case 'json':
      return parseJson(lines, patchText);
    default:
      throw new Error('bad format');
  }
}

// ----------------------------------------------------------- edit applying

interface Move {
  old: string;
  nw: string;
}

function applyHunks(
  path: string,
  fileText: string,
  hunks: Hunk[],
  strict: boolean,
): { ok: true; text: string } | { ok: false; fail: EditFailure } {
  let { lines, br, eol } = parseFileLines(fileText);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitBody(h.body);
    if (o.length === 0) {
      // Insert the new lines after the first A + d lines.
      const ins = n.map((x) => x.text);
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const atEnd = pos === lines.length;
      lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
      if (atEnd) eol = !h.noEol;
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, 0, strict);
    if (!found) return { ok: false, fail: { code: 'no-match', path } };
    const target = h.a - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const replacement = buildReplacement(lines, best, o, n, found.tier);
    const runsToEnd = best + o.length === lines.length;
    lines = [...lines.slice(0, best), ...replacement, ...lines.slice(best + o.length)];
    if (runsToEnd) eol = !h.noEol;
    d += n.length - o.length;
  }
  return { ok: true, text: joinFileLines(lines, br, eol) };
}

function applyUnified(tree: Tree, edit: Extract<Edit, { kind: 'unified' }>, strict: boolean, moves: Move[]): EditResult {
  if (edit.mode === 'create') {
    const newPath = edit.newPath as string;
    if (!isSafePath(newPath)) return fail('unsafe', newPath);
    if (tree.get(newPath).exists) return fail('exists', newPath);
    const plus: string[] = [];
    for (const h of edit.hunks) {
      for (const b of h.body) {
        if (b.t === 'new') plus.push(b.text);
      }
    }
    let endsWithBreak = true;
    outer: for (let hi = edit.hunks.length - 1; hi >= 0; hi--) {
      const body = edit.hunks[hi].body;
      for (let bi = body.length - 1; bi >= 0; bi--) {
        if (body[bi].t === 'new') {
          endsWithBreak = !(bi + 1 < body.length && body[bi + 1].t === 'backslash');
          break outer;
        }
      }
    }
    tree.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (endsWithBreak ? '\n' : ''));
    return OK;
  }
  if (edit.mode === 'delete') {
    const oldPath = edit.oldPath as string;
    if (!isSafePath(oldPath)) return fail('unsafe', oldPath);
    if (!tree.get(oldPath).exists) return fail('missing', oldPath);
    tree.delete(oldPath);
    return OK;
  }
  if (edit.mode === 'move') {
    const oldPath = edit.oldPath as string;
    const newPath = edit.newPath as string;
    if (!isSafePath(oldPath)) return fail('unsafe', oldPath);
    if (!isSafePath(newPath)) return fail('unsafe', newPath);
    if (!tree.get(oldPath).exists) return fail('missing', oldPath);
    if (tree.get(newPath).exists) return fail('exists', newPath);
    const res = applyHunks(oldPath, tree.get(oldPath).text, edit.hunks, strict);
    if (!res.ok) return { ok: false, fail: res.fail };
    tree.delete(oldPath);
    tree.set(newPath, res.text);
    moves.push({ old: oldPath, nw: newPath });
    return OK;
  }
  // change
  const oldPath = edit.oldPath as string;
  if (!isSafePath(oldPath)) return fail('unsafe', oldPath);
  if (!tree.get(oldPath).exists) return fail('missing', oldPath);
  const res = applyHunks(oldPath, tree.get(oldPath).text, edit.hunks, strict);
  if (!res.ok) return { ok: false, fail: res.fail };
  tree.set(oldPath, res.text);
  return OK;
}

function applySearchReplace(tree: Tree, edit: Extract<Edit, { kind: 'search-replace' }>, strict: boolean): EditResult {
  if (!isSafePath(edit.path)) return fail('unsafe', edit.path);
  if (edit.oldLines.length === 0) {
    if (tree.get(edit.path).exists) return fail('exists', edit.path);
    tree.set(edit.path, edit.newLines.length === 0 ? '' : edit.newLines.join('\n') + '\n');
    return OK;
  }
  const f = tree.get(edit.path);
  if (!f.exists) return fail('missing', edit.path);
  const { lines, br, eol } = parseFileLines(f.text);
  const found = findTier(lines, edit.oldLines, 0, strict);
  if (!found) return fail('no-match', edit.path);
  if (found.occ.length > 1) return fail('ambiguous', edit.path);
  const start = found.occ[0];
  const nLines: NLine[] = edit.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
  const replacement = buildReplacement(lines, start, edit.oldLines, nLines, found.tier);
  const out = [...lines.slice(0, start), ...replacement, ...lines.slice(start + edit.oldLines.length)];
  tree.set(edit.path, joinFileLines(out, br, eol));
  return OK;
}

function applyV4aAdd(tree: Tree, edit: Extract<Edit, { kind: 'v4a-add' }>): EditResult {
  if (!isSafePath(edit.path)) return fail('unsafe', edit.path);
  if (tree.get(edit.path).exists) return fail('exists', edit.path);
  tree.set(edit.path, edit.lines.length === 0 ? '' : edit.lines.join('\n') + '\n');
  return OK;
}

function applyV4aDelete(tree: Tree, edit: Extract<Edit, { kind: 'v4a-delete' }>): EditResult {
  if (!isSafePath(edit.path)) return fail('unsafe', edit.path);
  if (!tree.get(edit.path).exists) return fail('missing', edit.path);
  tree.delete(edit.path);
  return OK;
}

function applyV4aUpdate(
  tree: Tree,
  edit: Extract<Edit, { kind: 'v4a-update' }>,
  strict: boolean,
  moves: Move[],
): EditResult {
  if (!isSafePath(edit.path)) return fail('unsafe', edit.path);
  if (edit.moveTo !== null && !isSafePath(edit.moveTo)) return fail('unsafe', edit.moveTo);
  const f = tree.get(edit.path);
  if (!f.exists) return fail('missing', edit.path);
  if (edit.moveTo !== null && tree.get(edit.moveTo).exists) return fail('exists', edit.moveTo);
  let { lines, br, eol } = parseFileLines(f.text);
  let cursor = 0;
  for (const ch of edit.chunks) {
    if (ch.anchor !== null) {
      const a = findTier(lines, [ch.anchor], cursor, strict);
      if (!a) return fail('no-match', edit.path);
      cursor = a.occ[0] + 1;
    }
    const { o, n } = splitBody(ch.body);
    if (o.length === 0) {
      const ins = n.map((x) => x.text);
      let pos = ch.eof ? lines.length : cursor;
      if (pos > lines.length) pos = lines.length;
      if (pos < 0) pos = 0;
      lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
      cursor = pos + ins.length;
      continue;
    }
    let start: number;
    if (ch.eof) {
      // First tier with an occurrence that ends at the file's last line.
      let found: { tier: number; occ: number[] } | null = null;
      const maxTier = strict ? 0 : 2;
      for (let t = 0; t <= maxTier; t++) {
        const occ = findOccurrences(lines, o, t, cursor).filter((p) => p + o.length === lines.length);
        if (occ.length > 0) {
          found = { tier: t, occ };
          break;
        }
      }
      if (!found) return fail('no-match', edit.path);
      start = found.occ[0];
      const replacement = buildReplacement(lines, start, o, n, found.tier);
      lines = [...lines.slice(0, start), ...replacement, ...lines.slice(start + o.length)];
      cursor = start + replacement.length;
    } else {
      const found = findTier(lines, o, cursor, strict);
      if (!found) return fail('no-match', edit.path);
      start = found.occ[0];
      const replacement = buildReplacement(lines, start, o, n, found.tier);
      lines = [...lines.slice(0, start), ...replacement, ...lines.slice(start + o.length)];
      cursor = start + replacement.length;
    }
  }
  const text = joinFileLines(lines, br, eol);
  if (edit.moveTo !== null) {
    tree.delete(edit.path);
    tree.set(edit.moveTo, text);
    moves.push({ old: edit.path, nw: edit.moveTo });
  } else {
    tree.set(edit.path, text);
  }
  return OK;
}

function applyJsonCreate(tree: Tree, edit: Extract<Edit, { kind: 'json-create' }>): EditResult {
  if (!isSafePath(edit.path)) return fail('unsafe', edit.path);
  if (tree.get(edit.path).exists) return fail('exists', edit.path);
  tree.set(edit.path, edit.fileText);
  return OK;
}

function applyJsonStrReplace(tree: Tree, edit: Extract<Edit, { kind: 'json-str-replace' }>): EditResult {
  if (!isSafePath(edit.path)) return fail('unsafe', edit.path);
  const f = tree.get(edit.path);
  if (!f.exists) return fail('missing', edit.path);
  const { br } = parseFileLines(f.text);
  let text = f.text;
  let oldStr = edit.oldStr;
  let newStr = edit.newStr;
  if (br === '\r\n') {
    text = text.split('\r\n').join('\n');
    oldStr = oldStr.split('\r\n').join('\n');
    newStr = newStr.split('\r\n').join('\n');
  }
  // Count overlapping occurrences; stop after two.
  let count = 0;
  let firstPos = -1;
  let idx = text.indexOf(oldStr);
  while (idx !== -1) {
    count++;
    if (count === 1) firstPos = idx;
    if (count > 1) break;
    idx = text.indexOf(oldStr, idx + 1);
  }
  if (count === 0) return fail('no-match', edit.path);
  if (count > 1) return fail('ambiguous', edit.path);
  const result = text.slice(0, firstPos) + newStr + text.slice(firstPos + oldStr.length);
  tree.set(edit.path, br === '\r\n' ? result.split('\n').join('\r\n') : result);
  return OK;
}

function applyJsonInsert(tree: Tree, edit: Extract<Edit, { kind: 'json-insert' }>): EditResult {
  if (!isSafePath(edit.path)) return fail('unsafe', edit.path);
  const f = tree.get(edit.path);
  if (!f.exists) return fail('missing', edit.path);
  const { lines, br, eol } = parseFileLines(f.text);
  if (edit.insertLine < 0 || edit.insertLine > lines.length) return fail('no-match', edit.path);
  const newLines = splitTextLines(edit.newStr);
  const out = [...lines.slice(0, edit.insertLine), ...newLines, ...lines.slice(edit.insertLine)];
  tree.set(edit.path, joinFileLines(out, br, eol));
  return OK;
}

function applyEdit(tree: Tree, edit: Edit, strict: boolean, moves: Move[]): EditResult {
  switch (edit.kind) {
    case 'noop':
      return OK;
    case 'unified':
      return applyUnified(tree, edit, strict, moves);
    case 'search-replace':
      return applySearchReplace(tree, edit, strict);
    case 'v4a-add':
      return applyV4aAdd(tree, edit);
    case 'v4a-delete':
      return applyV4aDelete(tree, edit);
    case 'v4a-update':
      return applyV4aUpdate(tree, edit, strict, moves);
    case 'json-create':
      return applyJsonCreate(tree, edit);
    case 'json-str-replace':
      return applyJsonStrReplace(tree, edit);
    case 'json-insert':
      return applyJsonInsert(tree, edit);
  }
}

// ------------------------------------------------------------- output

function writeTree(tree: Tree): void {
  for (const [path, e] of tree.entries()) {
    if (e.exists === e.origExists && e.text === e.origText) continue;
    if (e.exists) {
      const dir = dirname(path);
      if (dir !== '.') mkdirSync(dir, { recursive: true });
      writeFileSync(path, e.text, 'utf8');
    } else {
      try {
        rmSync(path, { force: true });
      } catch {
        // nothing to remove
      }
    }
  }
}

function computeOutput(tree: Tree, moves: Move[]): string[] {
  const entries: { key: string; line: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const mv of moves) {
    const o = tree.get(mv.old);
    const n = tree.get(mv.nw);
    if (o.origExists && !o.exists && !n.origExists && n.exists) {
      entries.push({ key: mv.nw, line: `R ${mv.old} -> ${mv.nw}` });
      movedOld.add(mv.old);
      movedNew.add(mv.nw);
    }
  }
  for (const [path, e] of tree.entries()) {
    if (movedOld.has(path) || movedNew.has(path)) continue;
    if (!e.origExists && e.exists) entries.push({ key: path, line: `A ${path}` });
    else if (e.origExists && !e.exists) entries.push({ key: path, line: `D ${path}` });
    else if (e.origExists && e.exists && e.text !== e.origText) entries.push({ key: path, line: `M ${path}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const lines = entries.map((e) => e.line);
  lines.push(entries.length === 1 ? 'ok: 1 file' : `ok: ${entries.length} files`);
  return lines;
}

// ----------------------------------------------------------------- main

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stdout.write('error: usage\n');
    process.exitCode = 2;
    return;
  }

  let patchText: string;
  if (args.patch === null || args.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(args.patch, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      process.exitCode = 2;
      return;
    }
  }

  const lines = patchLines(patchText);
  let format = args.format;
  if (format === 'auto') {
    const d = detectFormat(lines);
    if (!d) {
      process.stdout.write('error: format\n');
      process.exitCode = 2;
      return;
    }
    format = d;
  }

  let edits: Edit[];
  try {
    edits = parsePatch(format, lines, patchText);
  } catch (e) {
    if (e instanceof ParseFault) {
      process.stdout.write(`error: parse ${e.line}\n`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  if (edits.length === 0) {
    process.stdout.write('error: parse 1\n');
    process.exitCode = 2;
    return;
  }

  const tree = new Tree();
  const failures: EditFailure[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const r = applyEdit(tree, edit, args.strict, moves);
    if (!r.ok) failures.push(r.fail);
  }
  if (failures.length > 0) {
    const out: string[] = [];
    for (const f of failures) out.push(`error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    process.stdout.write(out.join('\n') + '\n');
    process.exitCode = 1;
    return;
  }

  const outLines = computeOutput(tree, moves);
  if (!args.check) writeTree(tree);
  process.stdout.write(outLines.join('\n') + '\n');
  process.exitCode = 0;
}

// ----------------------------------------------------------------- entry
// Trial mode (used by the grader): hand the trial to the kit runner.
// This must stay at the end of the file so that every class and function
// above is initialized before main() runs.
if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  main();
}
