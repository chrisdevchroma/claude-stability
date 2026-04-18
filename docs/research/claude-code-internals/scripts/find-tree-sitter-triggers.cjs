#!/usr/bin/env node
/**
 * find-tree-sitter-triggers.cjs
 *
 * Scan a directory tree for bash patterns known to trip Claude Code's
 * tree-sitter bash static analyzer, causing "Unhandled node type: ..." or
 * "Contains expansion"-style permission prompts even when the command is
 * allowlisted. See claude-code issues #42085 / #43713 / #48717.
 *
 * Usage:
 *   node find-tree-sitter-triggers.cjs <path> [<path> ...]
 *   node find-tree-sitter-triggers.cjs --help
 *
 * Options:
 *   --ext=md,cjs,js   File extensions to scan (default: md,cjs,js,json,sh)
 *   --limit=N         Max matches to print per category (default: 40)
 *
 * Output:
 *   For each trigger category, lists files and line numbers with the matched
 *   text. Note: some matches are false positives — escaped parens `\(\)` in
 *   grep patterns look like grouped alternation to this scanner but aren't
 *   real walker triggers. Manual review of the output is required.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PATTERNS = {
  'grouped alternation in grep -E/-P': /\b(grep|egrep)\b[^|;&`<>"']*?-[EP]\S*\s+["'][^"']*\([^"')]*\|[^"')]*\)[^"']*["']/g,
  'grouped alternation in sed -E': /\bsed\b[^|;&`<>"']*?-?E\S*\s*["'][^"']*\([^"')]*\|[^"')]*\)[^"']*["']/g,
  "ANSI-C string $'...'": /\$'(?:[^'\\]|\\.)*'/g,
  'brace expansion {a,b,c} (shell)': /(?<![\$\{\w])\{[^{}\s,]+,[^{}\s,]+(?:,[^{}\s]+)*\}/g,
  'process substitution <(cmd)/>(cmd)': /[<>]\([a-z][^)]{3,}\)/gi,
  'here-string <<<': /<<<\s*["'$]/g,
  'parameter expansion with subshell default': /\$\{[A-Za-z_][A-Za-z0-9_]*:[-+=?]\$\(/g,
};

function parseArgs(argv) {
  const args = { paths: [], exts: ['md', 'cjs', 'js', 'json', 'sh'], limit: 40 };
  for (const a of argv) {
    if (a === '--help' || a === '-h') { return { help: true }; }
    if (a.startsWith('--ext=')) args.exts = a.slice(6).split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--limit=')) args.limit = parseInt(a.slice(8), 10) || 40;
    else args.paths.push(a);
  }
  return args;
}

function printHelp() {
  const helpText = fs.readFileSync(__filename, 'utf8')
    .split('\n').slice(1).filter(l => l.startsWith(' *'))
    .map(l => l.replace(/^ \*\s?/, '')).join('\n');
  console.log(helpText);
}

function walk(dir, extSet) {
  const out = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.git')) continue;
      if (e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(full, extSet));
      else if (e.isFile()) {
        const ext = e.name.includes('.') ? e.name.split('.').pop() : '';
        if (extSet.has(ext)) out.push(full);
      }
    }
  } catch (_e) {}
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  if (args.paths.length === 0) {
    console.error('Error: at least one path argument required. Use --help for usage.');
    process.exit(2);
  }

  const extSet = new Set(args.exts);
  const files = [];
  for (const root of args.paths) {
    try {
      if (fs.statSync(root).isDirectory()) files.push(...walk(root, extSet));
      else files.push(root);
    } catch (e) {
      console.error('Skipping unreadable path:', root, '—', e.message);
    }
  }
  console.log(`Scanning ${files.length} files across ${args.paths.length} root(s)…\n`);

  const hits = {};
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (_e) { continue; }
    for (const [name, re] of Object.entries(PATTERNS)) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        (hits[name] = hits[name] || []).push({
          file,
          line: text.slice(0, m.index).split('\n').length,
          match: m[0].slice(0, 160),
        });
      }
    }
  }

  let totalHits = 0;
  for (const [name, entries] of Object.entries(hits)) {
    totalHits += entries.length;
    console.log(`── ${name}  (${entries.length} matches) ──`);
    const byFile = {};
    for (const e of entries) (byFile[e.file] = byFile[e.file] || []).push(e);
    const keys = Object.keys(byFile).sort().slice(0, args.limit);
    for (const f of keys) {
      console.log('  ' + f);
      for (const e of byFile[f].slice(0, 3)) {
        console.log(`    L${e.line}:  ${e.match}`);
      }
      if (byFile[f].length > 3) console.log(`    ... +${byFile[f].length - 3} more in this file`);
    }
    if (Object.keys(byFile).length > args.limit) {
      console.log(`  ... and ${Object.keys(byFile).length - args.limit} more files`);
    }
    console.log();
  }
  console.log(`Total: ${totalHits} matches across ${Object.keys(hits).length} categories.`);
  console.log('NOTE: Some matches are false positives (escaped parens, JS regex quantifiers,');
  console.log('      JSON examples in docs, shell subshells). Review each category manually.');
}

main();
