#!/usr/bin/env node
/**
 * verify-allowlist-parity.cjs
 *
 * Compare a local `.claude/settings.json` allow list against the canonical
 * gsd-ng template plus per-CLI granular patterns (gh/glab/fj/tea) generated
 * by `allowlist.cjs`. Flags drift: entries the local has but the template
 * doesn't ("extra"), or entries the template has but the local is missing.
 *
 * Useful after a gsd-ng install to confirm settings.json was regenerated
 * correctly, or after template edits to verify propagation.
 *
 * Usage:
 *   node verify-allowlist-parity.cjs \
 *     --local=<path/to/.claude/settings.json> \
 *     --template=<path/to/settings-sandbox.json> \
 *     [--allowlist-mod=<path/to/allowlist.cjs>] \
 *     [--clis=gh,fj]
 *
 * Options:
 *   --local=<path>          Path to installed settings.json (required)
 *   --template=<path>       Path to source settings-sandbox.json (required)
 *   --allowlist-mod=<path>  Path to allowlist.cjs exposing getPlatformCliPatterns(cli)
 *   --clis=<list>           Comma-separated platform CLIs to include in expected
 *                           allow (default: auto-detect from local entries)
 *
 * Exit codes: 0 exact parity, 1 drift detected, 2 bad args.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { local: null, template: null, allowlistMod: null, clis: null };
  for (const a of argv) {
    if (a === '--help' || a === '-h') return { help: true };
    if (a.startsWith('--local=')) args.local = a.slice(8);
    else if (a.startsWith('--template=')) args.template = a.slice(11);
    else if (a.startsWith('--allowlist-mod=')) args.allowlistMod = a.slice(16);
    else if (a.startsWith('--clis=')) args.clis = a.slice(7).split(',').map(s => s.trim()).filter(Boolean);
    else { console.error('Unknown arg:', a); return null; }
  }
  return args;
}

function printHelp() {
  const helpText = fs.readFileSync(__filename, 'utf8')
    .split('\n').slice(1).filter(l => l.startsWith(' *'))
    .map(l => l.replace(/^ \*\s?/, '')).join('\n');
  console.log(helpText);
}

function detectClis(localAllow) {
  // Auto-detect: if any Bash(<cli> <sub>) entry exists for a known CLI, include it.
  const KNOWN = ['gh', 'glab', 'fj', 'tea'];
  const found = [];
  for (const cli of KNOWN) {
    if (localAllow.some(e => e.startsWith(`Bash(${cli} `))) found.push(cli);
  }
  return found;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) process.exit(2);
  if (args.help) { printHelp(); return; }
  if (!args.local || !args.template) {
    console.error('Both --local=<path> and --template=<path> are required.');
    process.exit(2);
  }

  const local = JSON.parse(fs.readFileSync(args.local, 'utf8'));
  const tpl = JSON.parse(fs.readFileSync(args.template, 'utf8'));

  const localAllow = (local.permissions && local.permissions.allow) || [];
  const tplAllow = (tpl.permissions && tpl.permissions.allow) || [];

  let expected = [...tplAllow];
  if (args.allowlistMod) {
    const mod = require(path.resolve(args.allowlistMod));
    const clis = args.clis || detectClis(localAllow);
    console.log(`Including CLI granular patterns for: ${clis.join(', ') || '(none)'}`);
    for (const cli of clis) {
      if (typeof mod.getPlatformCliPatterns === 'function') {
        expected.push(...mod.getPlatformCliPatterns(cli));
      }
    }
  }

  const expectedSet = new Set(expected);
  const localSet = new Set(localAllow);

  const extra = [...localSet].filter(x => !expectedSet.has(x));
  const missing = [...expectedSet].filter(x => !localSet.has(x));

  console.log(`local entries: ${localSet.size}, expected: ${expectedSet.size}`);
  if (local.permissions && local.permissions.deny) {
    console.log(`local has deny list (${local.permissions.deny.length} entries) — ` +
      'current template ships no deny rules');
  } else {
    console.log('local has no deny list ✓');
  }

  if (extra.length === 0 && missing.length === 0) {
    console.log('✓ Allow list matches expected (template + CLI patterns) exactly.');
    process.exit(0);
  }

  if (extra.length) {
    console.log(`\nExtra in local (${extra.length}):`);
    for (const e of extra) console.log('  +', e);
  }
  if (missing.length) {
    console.log(`\nMissing from local (${missing.length}):`);
    for (const e of missing) console.log('  -', e);
  }
  process.exit(1);
}

main();
