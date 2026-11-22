import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];
let STRICT = false;
class Exit2 {
  constructor(line) { this.line = line; }
}
class Fail {
  constructor(code, path) { this.code = code; this.path = path; }
}
const blank = (s) => s.trim() === '';
function patchLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}
function safe(p) {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}
function leadWS(s) { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; }
function trailTrim(s) { return s.replace(/[ \t]+$/, ''); }
function bothTrim(s) { return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''); }
function splitFile(text) {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const fin = text.endsWith(br);
  const parts = text.split(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}
function joinFile(lines, br, fin) {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}
class Tree {
  constructor() { this.orig = new Map(); this.now = new Map(); this.moves = []; }
  original(p) {
    if (!this.orig.has(p)) {
      let v = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p);
  }
  get(p) { return this.now.has(p) ? this.now.get(p) : this.original(p); }
}
function lineEq(a, b, tier) {
  if (tier === 0) return a === b;
  if (tier === 1) return trailTrim(a) === trailTrim(b);
  return bothTrim(a) === bothTrim(b);
}
function occurrencesAt(lines, o, tier) {
  const out = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) { if (!lineEq(lines[i + j], o[j], tier)) { ok = false; break; } }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(lines, o) {
  const tiers = STRICT ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return { tier: -1, occ: [] };
}
function findTierFrom(lines, o, from) {
  const tiers = STRICT ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t).filter((p) => p >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return { tier: -1, occ: [] };
}
function reindentLine(line, tier, fileFirst, oFirst) {
  if (tier !== 2) return line;
  if (line === '' || line.trim() === '') return line;
  const F = leadWS(fileFirst);
  const P = leadWS(oFirst);
  if (line.startsWith(P)) return F + line.slice(P.length);
  return line;
}
// entries: {text, ctx, oIdx} for N; oTexts are O texts. Returns replacement lines.
function buildN(nEntries, fileLines, pos, oTexts, tier) {
  const out = [];
  for (const e of nEntries) {
    if (e.ctx) out.push(fileLines[pos + e.oIdx]);
    else out.push(reindentLine(e.text, tier, fileLines[pos] ?? '', oTexts[0] ?? ''));
  }
  return out;
}
function detect(lines) {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}
function jsonEdit(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = o.new_str === undefined ? '' : o.new_str;
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s) => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = f.lines.slice();
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(lines, f.br, f.fin));
    };
  }
  return null;
}
function jsonEdits(text, lines) {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits = [];
  if (lines[first].trimStart().startsWith('[')) {
    let v;
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e = null;
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}
function parseDiffPath(line) {
  const raw = line.slice(4);
  const cut = raw.split('\t')[0];
  let p = cut.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}
function parseDiffGit(line) {
  const rest = line.slice('diff --git '.length);
  const idx = rest.indexOf(' b/');
  if (idx < 0 || !rest.startsWith('a/')) return null;
  const x = rest.slice(2, idx);
  const y = rest.slice(idx + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}
function unifiedEdits(lines) {
  const sections = [];
  let cur = null;
  const newSection = (oldP, newP, hasPair) => {
    const s = { oldP, newP, hasPair, diffOld: oldP, diffNew: newP, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [], inHeader: true };
    sections.push(s); cur = s; return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const pr = parseDiffGit(line);
      if (pr === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection(pr[0], pr[1], false);
      i++; continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (cur !== null && cur.inHeader && !cur.hasPair) {
          cur.oldP = parseDiffPath(line); cur.newP = parseDiffPath(next); cur.hasPair = true;
        } else {
          newSection(parseDiffPath(line), parseDiffPath(next), true);
        }
        i += 2; continue;
      }
      if (cur !== null && cur.inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++; continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*|)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const A = Number(m[1]);
      const body = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j];
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          if (bl.startsWith('\\')) { if (body.length > 0) body[body.length - 1].noEol = true; }
          else body.push({ kind: bl === '' ? ' ' : bl[0], text: bl === '' ? '' : bl.slice(1), noEol: false });
          j++; continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1].kind === ' ' && body[body.length - 1].text === '') body.pop();
      cur.hunks.push({ A, body });
      cur.inHeader = false;
      i = j; continue;
    }
    if (cur !== null && cur.inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i++; continue;
    }
    i++;
  }
  const edits = [];
  for (const s of sections) {
    let oldP = s.oldP; let newP = s.newP;
    if (!s.hasPair) {
      if (s.renameFrom !== null) oldP = s.renameFrom;
      if (s.renameTo !== null) newP = s.renameTo;
    }
    edits.push(makeUnifiedEdit(oldP, newP, s));
  }
  return edits;
}
function hunkON(h) {
  const O = []; const N = [];
  for (const e of h.body) {
    if (e.kind === ' ') { O.push({ text: e.text, ctx: true, oIdx: O.length }); N.push({ text: e.text, ctx: true, oIdx: O.length - 1 }); }
    else if (e.kind === '-') O.push({ text: e.text, ctx: false, oIdx: O.length });
    else if (e.kind === '+') N.push({ text: e.text, ctx: false, oIdx: -1 });
  }
  return { O, N };
}
function lastNoEol(h) {
  for (let k = h.body.length - 1; k >= 0; k--) {
    if (h.body[k].kind === ' ' || h.body[k].kind === '+') return h.body[k].noEol;
  }
  return false;
}
function applyHunks(fileText, hunks, path) {
  const f = splitFile(fileText);
  const lines = f.lines.slice();
  let fin = f.fin;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = hunkON(h);
    const oTexts = O.map((e) => e.text);
    const nEntries = N;
    if (oTexts.length === 0) {
      const ins = Math.min(h.A + d, lines.length);
      const atEnd = ins === lines.length;
      const repl = nEntries.map((e) => e.text);
      lines.splice(ins, 0, ...repl);
      if (atEnd && repl.length > 0) fin = !lastNoEol(h);
      d += nEntries.length;
    } else {
      const found = findTier(lines, oTexts);
      if (found.tier < 0) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = found.occ[0]; let bestDist = Math.abs(best - target);
      for (const p of found.occ) { const dist = Math.abs(p - target); if (dist < bestDist) { best = p; bestDist = dist; } }
      const atEnd = best + oTexts.length === lines.length;
      const repl = buildN(nEntries, lines, best, oTexts, found.tier);
      lines.splice(best, oTexts.length, ...repl);
      if (atEnd) fin = !lastNoEol(h);
      d += nEntries.length - oTexts.length;
    }
  }
  return joinFile(lines, f.br, fin);
}
function makeUnifiedEdit(oldP, newP, s) {
  const isCreate = oldP === '/dev/null' || s.newFile;
  const isDelete = newP === '/dev/null' || s.delFile;
  return (tree) => {
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus = [];
      let noEol = false;
      for (const h of s.hunks) {
        for (const e of h.body) if (e.kind === '+') plus.push(e.text);
        const lastPlus = [...h.body].reverse().find((e) => e.kind === '+');
        if (lastPlus) noEol = lastPlus.noEol;
      }
      // noEol only matters for the last hunk's last + line overall; recompute:
      let lastNo = false;
      for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const lp = [...s.hunks[hi].body].reverse().find((e) => e.kind === '+');
        if (lp) { lastNo = lp.noEol; break; }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastNo ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(before, s.hunks, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push({ old: oldP, nw: newP });
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(before, s.hunks, oldP));
  };
}
function searchReplaceEdits(lines) {
  const edits = [];
  let prevEnd = -1;
  let prevPath = null;
  for (let s = 0; s < lines.length; s++) {
    if (lines[s].trimEnd() !== '<<<<<<< SEARCH') continue;
    let path = null;
    for (let k = s - 1; k > prevEnd; k--) {
      const l = lines[k];
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim(); break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let sep = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '=======') { sep = j; break; }
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, sep);
    const newLines = lines.slice(sep + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(f.lines, oldLines);
      if (found.tier < 0) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0];
      const repl = newLines.map((t) => reindentLine(t, found.tier, f.lines[pos] ?? '', oldLines[0]));
      const out = f.lines.slice();
      out.splice(pos, oldLines.length, ...repl);
      tree.now.set(p, joinFile(out, f.br, f.fin));
    });
    prevPath = p;
    prevEnd = rep;
    s = rep;
  }
  return edits;
}
function isSectionStart(l) {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}
function v4aEdits(lines) {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last])) last--;
  if (last < 0 || lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i])) { i++; continue; }
    const line = lines[i];
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File:'.length).trim();
      const fl = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j])) {
        const bl = lines[j];
        if (bl.startsWith('+')) fl.push(bl.slice(1));
        else if (bl === '') fl.push('');
        else throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      while (fl.length > 0 && fl[fl.length - 1] === '') fl.pop();
      edits.push(((pp, fll) => (tree) => {
        if (!safe(pp)) throw new Fail('unsafe', pp);
        if (tree.get(pp) !== null) throw new Fail('exists', pp);
        tree.now.set(pp, fll.length === 0 ? '' : fll.join('\n') + '\n');
      })(p, fl));
      i = j; continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File:'.length).trim();
      edits.push(((pp) => (tree) => {
        if (!safe(pp)) throw new Fail('unsafe', pp);
        if (tree.get(pp) === null) throw new Fail('missing', pp);
        tree.now.set(pp, null);
      })(p));
      i++; continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File:'.length).trim();
      const updateLine = i + 1;
      let j = i + 1;
      let moveTo = null;
      if (j < last && lines[j].startsWith('*** Move to: ')) { moveTo = lines[j].slice('*** Move to:'.length).trim(); j++; }
      const chunks = [];
      let cur = null;
      while (j < last && !isSectionStart(lines[j])) {
        const bl = lines[j];
        if (bl.startsWith('@@')) {
          cur = { anchor: bl.slice(2).trim(), body: [], eof: false };
          chunks.push(cur); j++; continue;
        }
        if (bl.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true; cur = null; j++; continue;
        }
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`);
            cur = { anchor: '', body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push({ kind: bl === '' ? ' ' : bl[0], text: bl === '' ? '' : bl.slice(1) });
          j++; continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1];
        while (lc.body.length > 0 && lc.body[lc.body.length - 1].kind === ' ' && lc.body[lc.body.length - 1].text === '') lc.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(makeV4aEdit(p, moveTo, chunks));
      i = j; continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}
function makeV4aEdit(p, moveTo, chunks) {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    const lines = f.lines.slice();
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== '') {
        const af = findTierFrom(lines, [ch.anchor], cursor);
        if (af.tier < 0) throw new Fail('no-match', p);
        cursor = af.occ[0] + 1;
      }
      const O = []; const N = [];
      for (const e of ch.body) {
        if (e.kind === ' ') { O.push({ text: e.text, ctx: true, oIdx: O.length }); N.push({ text: e.text, ctx: true, oIdx: O.length - 1 }); }
        else if (e.kind === '-') O.push({ text: e.text, ctx: false, oIdx: O.length });
        else if (e.kind === '+') N.push({ text: e.text, ctx: false, oIdx: -1 });
      }
      const oTexts = O.map((e) => e.text);
      if (oTexts.length === 0) {
        const ins = ch.eof ? lines.length : cursor;
        const repl = N.map((e) => e.text);
        lines.splice(ins, 0, ...repl);
        cursor = ins + repl.length;
      } else {
        let found;
        if (ch.eof) {
          found = { tier: -1, occ: [] };
          const tiers = STRICT ? [0] : [0, 1, 2];
          for (const t of tiers) {
            const occ = occurrencesAt(lines, oTexts, t).filter((pos) => pos >= cursor && pos + oTexts.length === lines.length);
            if (occ.length > 0) { found = { tier: t, occ }; break; }
          }
        } else {
          found = findTierFrom(lines, oTexts, cursor);
        }
        if (found.tier < 0) throw new Fail('no-match', p);
        const pos = found.occ[0];
        const repl = buildN(N, lines, pos, oTexts, found.tier);
        lines.splice(pos, oTexts.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const out = joinFile(lines, f.br, f.fin);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: p, nw: moveTo });
    } else {
      tree.now.set(p, out);
    }
  };
}
function run(args) {
  let format = null;
  let check = false;
  let strict = false;
  const pos = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  STRICT = strict;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  let text = '';
  try { text = readFileSync(file ?? 0, 'utf8'); } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits;
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try { edit(tree); } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const cmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows = [];
  const usedR = new Set();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const wasNew = tree.original(mv.nw);
    const nowOld = tree.now.has(mv.old) ? tree.now.get(mv.old) : wasOld;
    const nowNew = tree.now.has(mv.nw) ? tree.now.get(mv.nw) : wasNew;
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.nw, text: `R ${mv.old} -> ${mv.nw}` });
      usedR.add(mv.old); usedR.add(mv.nw);
    }
  }
  for (const p of [...tree.now.keys()].sort(cmp)) {
    if (usedR.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p);
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => cmp(a.key, b.key));
  const outLines = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, now); }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}
const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
