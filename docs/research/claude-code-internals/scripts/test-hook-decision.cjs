#!/usr/bin/env node
/**
 * test-hook-decision.cjs
 *
 * Feed a command to the gsd-ng bash-safety-hook and print its decomposition
 * and permission decision. Useful when diagnosing why a specific command
 * gets a "Contains expansion" or "Unhandled node type" prompt despite the
 * hook existing — the hook's decision is the first thing to rule out.
 *
 * Usage:
 *   node test-hook-decision.cjs --hook=<hook.cjs> --cmd='<shell command>'
 *   node test-hook-decision.cjs --hook=<hook.cjs> --cmds-from=<file.txt>
 *   node test-hook-decision.cjs --help
 *
 * Options:
 *   --hook=<path>       Path to bash-safety-hook.cjs (required)
 *   --cmd=<string>      Single command to test
 *   --cmds-from=<file>  File with one command per line (blank lines skipped)
 *   --project-dir=<p>   Set CLAUDE_PROJECT_DIR env for hook settings load
 *                       (default: current working directory)
 *   --json              Emit raw JSON decisions instead of human-readable output
 *
 * Output:
 *   For each command, prints the decomposed sub-commands with match status
 *   and the final allow/deny/passthrough decision.
 *
 * Exit codes: 0 on success, 2 on bad args, 1 if any command returns
 * deny/passthrough (useful in CI gating).
 */
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { hook: null, cmd: null, cmdsFrom: null, projectDir: process.cwd(), json: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') return { help: true };
    if (a.startsWith('--hook=')) args.hook = a.slice(7);
    else if (a.startsWith('--cmd=')) args.cmd = a.slice(6);
    else if (a.startsWith('--cmds-from=')) args.cmdsFrom = a.slice(12);
    else if (a.startsWith('--project-dir=')) args.projectDir = a.slice(14);
    else if (a === '--json') args.json = true;
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

function loadCommands(args) {
  if (args.cmd !== null) return [args.cmd];
  if (args.cmdsFrom) {
    return fs.readFileSync(args.cmdsFrom, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) { process.exit(2); }
  if (args.help) { printHelp(); return; }
  if (!args.hook) { console.error('--hook=<path> is required'); process.exit(2); }

  const hookAbs = path.resolve(args.hook);
  if (!fs.existsSync(hookAbs)) { console.error('Hook not found:', hookAbs); process.exit(2); }

  const cmds = loadCommands(args);
  if (cmds.length === 0) { console.error('Provide --cmd=... or --cmds-from=...'); process.exit(2); }

  process.env.CLAUDE_PROJECT_DIR = args.projectDir;
  const hook = require(hookAbs);
  const settings = hook.loadMergedSettings();

  let anyNonAllow = false;
  for (const cmd of cmds) {
    const subs = hook.decomposeCommand(cmd);
    const decision = hook.decide(cmd, settings);
    if (decision.decision !== 'allow') anyNonAllow = true;

    if (args.json) {
      console.log(JSON.stringify({ cmd, subs, decision }));
      continue;
    }

    console.log('═'.repeat(78));
    console.log('cmd:', cmd.slice(0, 140) + (cmd.length > 140 ? '...' : ''));
    console.log('decomposed sub-commands:');
    const allow = settings.permissions.allow || [];
    for (const s of subs) {
      const matched = allow.find(p => hook.commandMatchesPattern(s, p));
      console.log('  [' + (matched ? 'OK  ' : 'MISS') + '] ' + s.slice(0, 120));
      if (matched) console.log('         via', matched);
    }
    console.log('decision:', decision.decision, '—', (decision.reason || '(no reason)').slice(0, 140));
  }

  if (anyNonAllow) process.exit(1);
}

main();
