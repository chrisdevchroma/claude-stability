#!/usr/bin/env node
/**
 * scan-session-logs.cjs
 *
 * Scan Claude Code session JSONL logs to answer: "how often does a specific
 * bash command pattern appear, and what happens when it runs?" Designed to
 * validate hypotheses like "pattern X causes permission prompts" by checking
 * historical outcomes across many sessions.
 *
 * The default pattern detects parameter-expansion-with-subshell-default —
 * `${VAR:-$(cmd)}` — which is documented in claude-code #43713 as a trigger
 * for the tree-sitter walker's "Contains expansion" prompt. Override with
 * --pattern for other investigations.
 *
 * Usage:
 *   node scan-session-logs.cjs <session-log-or-dir> [<more>...]
 *   node scan-session-logs.cjs --help
 *
 * Options:
 *   --pattern=<regex>   JS regex to match against tool_use command strings
 *                       (default: /\$\{[A-Za-z_]\w*:[-+=?]\$\(/  — paramExp+subshell)
 *   --inspect           For each matching tool call, print outcome (errored,
 *                       result text) — useful for detecting permission blocks
 *   --examples=N        Print N example commands (default: 5)
 *
 * Exit codes: 0 on success, 2 on bad args.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {
    paths: [],
    pattern: /\$\{[A-Za-z_]\w*:[-+=?]\$\(/,
    inspect: false,
    examples: 5,
  };
  for (const a of argv) {
    if (a === '--help' || a === '-h') return { help: true };
    if (a.startsWith('--pattern=')) args.pattern = new RegExp(a.slice(10));
    else if (a === '--inspect') args.inspect = true;
    else if (a.startsWith('--examples=')) args.examples = parseInt(a.slice(11), 10) || 5;
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

function expandPaths(inputs) {
  const out = [];
  for (const p of inputs) {
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        for (const f of fs.readdirSync(p)) {
          if (f.endsWith('.jsonl')) out.push(path.join(p, f));
        }
      } else if (st.isFile()) {
        out.push(p);
      }
    } catch (_e) {}
  }
  return out;
}

function scanFile(file, args) {
  const text = fs.readFileSync(file, 'utf8');
  const usesById = new Map();
  const stats = {
    totalBash: 0,
    withPattern: 0,
    erroredResults: 0,
    blockedLookingResults: 0,
    examples: [],
    inspectEntries: [],
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); }
    catch (_e) { continue; }
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.type === 'tool_use' && node.name === 'Bash'
          && node.input && typeof node.input.command === 'string') {
        stats.totalBash++;
        const cmd = node.input.command;
        if (args.pattern.test(cmd)) {
          stats.withPattern++;
          if (stats.examples.length < args.examples) {
            stats.examples.push(cmd.slice(0, 140));
          }
          usesById.set(node.id, cmd);
        }
      }
      if (node.type === 'tool_result' && node.tool_use_id && usesById.has(node.tool_use_id)) {
        const content = Array.isArray(node.content)
          ? node.content.map(c => typeof c === 'string' ? c : (c.text || '')).join('\n')
          : (typeof node.content === 'string' ? node.content : JSON.stringify(node.content));
        const looksBlocked = /permission|denied|blocked|not allowed/i.test(content);
        const isErr = !!node.is_error;
        if (isErr) stats.erroredResults++;
        if (looksBlocked) stats.blockedLookingResults++;
        if (args.inspect && (isErr || looksBlocked)) {
          stats.inspectEntries.push({
            cmd: usesById.get(node.tool_use_id).slice(0, 120),
            err: isErr,
            blocked: looksBlocked,
            result: content.slice(0, 260).replace(/\n/g, ' | '),
          });
        }
      }
      for (const k of Object.keys(node)) walk(node[k]);
    };
    walk(obj);
  }
  return stats;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  if (args.paths.length === 0) {
    console.error('Error: at least one session log or directory argument required. Use --help.');
    process.exit(2);
  }

  const files = expandPaths(args.paths);
  console.log(`Scanning ${files.length} session log file(s) for pattern: ${args.pattern}\n`);

  const total = { totalBash: 0, withPattern: 0, erroredResults: 0, blockedLookingResults: 0 };
  const allExamples = [];
  const allInspect = [];

  for (const f of files) {
    let stats;
    try { stats = scanFile(f, args); }
    catch (_e) { continue; }
    total.totalBash += stats.totalBash;
    total.withPattern += stats.withPattern;
    total.erroredResults += stats.erroredResults;
    total.blockedLookingResults += stats.blockedLookingResults;
    if (allExamples.length < args.examples) {
      for (const e of stats.examples) if (allExamples.length < args.examples) allExamples.push(e);
    }
    if (args.inspect) allInspect.push(...stats.inspectEntries);
  }

  console.log(`Total Bash tool calls:         ${total.totalBash}`);
  console.log(`With matching pattern:         ${total.withPattern}`);
  console.log(`  marked is_error:             ${total.erroredResults}`);
  console.log(`  results with block-like text: ${total.blockedLookingResults}`);
  console.log('\nExample matching commands:');
  for (const e of allExamples) console.log('  -', e);

  if (args.inspect && allInspect.length) {
    console.log('\n── Inspect: errored or block-looking results ──');
    for (const r of allInspect) {
      console.log('--');
      console.log('ERR:', r.err, '| BLOCKED-TEXT:', r.blocked);
      console.log('CMD:', r.cmd);
      console.log('RES:', r.result);
    }
  }
}

main();
