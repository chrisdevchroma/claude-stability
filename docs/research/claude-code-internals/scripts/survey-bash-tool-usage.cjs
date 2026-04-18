#!/usr/bin/env node
/**
 * survey-bash-tool-usage.cjs
 *
 * Walk a directory tree looking at fenced ```bash``` code blocks and inline
 * backtick commands, extract the first token of each command line, and
 * report which tools are invoked that are NOT in a given allowlist.
 *
 * Useful when planning allowlist additions — tells you which POSIX
 * utilities or shell builtins a project actually uses that would otherwise
 * trigger a permission prompt.
 *
 * Usage:
 *   node survey-bash-tool-usage.cjs <path> [<path>...] \
 *     [--allowlisted=git,node,echo,ls,...]
 *   node survey-bash-tool-usage.cjs --help
 *
 * Options:
 *   --allowlisted=<list>   Comma-separated list of tools to exclude from the
 *                          "missing" report. Defaults to the gsd-ng template's
 *                          current allowlist (set in KNOWN_TEMPLATE_DEFAULT).
 *   --ext=<list>           File extensions to scan (default: md)
 *   --limit=<N>            Max rows in the final report (default: 40)
 *
 * Output:
 *   Ranked list of first-token commands found in bash contexts that are not
 *   in the allowlist. Also lists shell builtins separately since they need a
 *   different treatment (STRUCTURAL_KEYWORDS vs allowlist).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const KNOWN_TEMPLATE_DEFAULT = new Set([
  'node', 'git', 'npm', 'npx',
  'ssh-add', 'ssh-keygen',
  'date', 'echo', 'cat', 'ls', 'mkdir', 'mktemp', 'rm', 'cp', 'mv', 'wc',
  'head', 'tail', 'sort', 'grep', 'find', 'tr', 'jq', 'test', 'touch',
  'chmod', 'sed', 'tar', 'curl', 'basename', 'dirname', 'cut', 'tee',
  'uniq', 'seq', 'pwd', 'printf', 'env', 'xargs', 'timeout', 'awk',
  'sleep', 'stat', 'diff', 'realpath', 'readlink', 'md5sum', 'sha256sum',
  'which', 'type', 'exit', 'return', 'local', 'export',
  'gh', 'glab', 'fj', 'tea',
]);

// Shell builtins — separate bucket since they need a different fix path
const SHELL_BUILTINS = new Set([
  'cd', 'eval', 'exec', 'source', '.', 'set', 'unset', 'shift', 'trap',
  'declare', 'readonly', 'alias', 'unalias', 'let', 'getopts', 'dirs',
  'read', 'fg', 'bg', 'jobs', 'wait', 'disown', 'bind', 'history', 'time',
  'times', 'ulimit', 'umask', 'help', 'suspend', 'pushd', 'popd',
  'true', 'false',
]);

const KNOWN_EXTERNALS = new Set([
  'bash','sh','zsh','vi','vim','nano','less','more',
  'perl','python','python3','ruby','go','cargo','rustc','java',
  'ln','rmdir','install','ping','nc','wget','hostname','whoami','id','groups','df','du',
  'mount','lsof','netstat','ss','ps','pgrep','pkill','kill','nohup','watch','yes',
  'column','paste','comm','join','nl','rev','expand','unexpand','fold','fmt','iconv',
  'hexdump','xxd','tac','shuf','bc','dc','nproc','uname','command','builtin',
  'file','md5sum','sha256sum','base64',
]);

function parseArgs(argv) {
  const args = { paths: [], allowlisted: null, exts: ['md'], limit: 40 };
  for (const a of argv) {
    if (a === '--help' || a === '-h') return { help: true };
    if (a.startsWith('--allowlisted=')) args.allowlisted = new Set(a.slice(14).split(',').map(s => s.trim()).filter(Boolean));
    else if (a.startsWith('--ext=')) args.exts = a.slice(6).split(',').map(s => s.trim()).filter(Boolean);
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

const FIRST_TOKEN = /^\s*([a-z][a-z0-9_-]*)\b/;

function recordTool(map, tool, file) {
  if (!map.has(tool)) map.set(tool, { count: 0, files: new Set() });
  const rec = map.get(tool);
  rec.count++;
  rec.files.add(file);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  if (args.paths.length === 0) {
    console.error('Error: at least one path argument required. Use --help.');
    process.exit(2);
  }

  const allowlisted = args.allowlisted || KNOWN_TEMPLATE_DEFAULT;
  const extSet = new Set(args.exts);
  const files = [];
  for (const root of args.paths) {
    try {
      if (fs.statSync(root).isDirectory()) files.push(...walk(root, extSet));
      else files.push(root);
    } catch (_e) {}
  }
  console.log(`Scanning ${files.length} files across ${args.paths.length} root(s)…\n`);

  const usage = new Map();
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (_e) { continue; }
    // Fenced ```bash / ```sh / ```shell blocks
    const fenced = text.match(/```(?:bash|sh|shell)\n([\s\S]*?)```/g) || [];
    for (const block of fenced) {
      const body = block.replace(/^```[a-z]*\n/, '').replace(/```$/, '');
      for (const rawLine of body.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        // Strip leading KEY=value env prefixes
        const stripped = line.replace(/^([A-Z_][A-Z0-9_]*=\S*\s+)+/i, '');
        // First token of the line
        const m = stripped.match(FIRST_TOKEN);
        if (m) recordTool(usage, m[1], file);
        // Also first token after each pipe
        for (const seg of stripped.split(/\s*\|\s*/).slice(1)) {
          const sm = seg.match(FIRST_TOKEN);
          if (sm) recordTool(usage, sm[1], file);
        }
      }
    }
    // Inline backticks `cmd arg1 arg2`
    const inline = text.match(/`([a-z][a-z0-9_-]*\s+[^`]*)`/g) || [];
    for (const b of inline) {
      const m = b.slice(1, -1).trim().match(FIRST_TOKEN);
      if (m) recordTool(usage, m[1], file);
    }
  }

  const missing = [];
  const builtins = [];
  for (const [tool, rec] of usage.entries()) {
    if (allowlisted.has(tool)) continue;
    const row = { tool, count: rec.count, files: rec.files.size };
    if (SHELL_BUILTINS.has(tool)) builtins.push(row);
    else if (KNOWN_EXTERNALS.has(tool)) missing.push(row);
    // Unknown tokens (likely variable names, not tools) are skipped
  }
  missing.sort((a, b) => b.count - a.count || b.files - a.files);
  builtins.sort((a, b) => b.count - a.count || b.files - a.files);

  console.log('── External tools NOT in allowlist ──');
  console.log('count  files  tool');
  for (const r of missing.slice(0, args.limit)) {
    console.log(String(r.count).padStart(5), String(r.files).padStart(6), ' ', r.tool);
  }

  if (builtins.length) {
    console.log('\n── Shell builtins (consider STRUCTURAL_KEYWORDS, not allowlist) ──');
    console.log('count  files  builtin');
    for (const r of builtins.slice(0, args.limit)) {
      console.log(String(r.count).padStart(5), String(r.files).padStart(6), ' ', r.tool);
    }
  }
}

main();
