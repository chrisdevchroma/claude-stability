# Bash-hook & tree-sitter diagnostic scripts

Node-based diagnostic tools for investigating Claude Code's Bash permission
pipeline — specifically the interaction between:

- **PreToolUse hook decomposition** (see upstream [liberzon/claude-hooks](https://github.com/liberzon/claude-hooks)
  and gsd-ng's port at `gsd-ng/hooks/bash-safety-hook.cjs`)
- **The tree-sitter bash static analyzer** used by Claude Code's sandbox to
  decide whether `autoAllowBashIfSandboxed` applies (regression documented
  in `../tree-sitter-walker-regression.md`)
- **Session logs** at `~/.claude/projects/<sanitized-cwd>/*.jsonl`

Each script is a standalone Node CLI (`.cjs`). Pass `--help` to any script
for usage. All scripts accept paths as arguments — none hardcode workspace
locations.

## When to reach for each tool

### `find-tree-sitter-triggers.cjs`

Scan a codebase for bash patterns that trip the tree-sitter walker. Use
before or after making tree-sitter-avoidance changes to a project's
workflow templates.

```sh
node find-tree-sitter-triggers.cjs path/to/gsd-ng/ --ext=md,sh
```

Detects: grouped alternation in `grep -E "..."`, ANSI-C strings, brace
expansion, process substitution, here-strings, `${VAR:-$(...)}` parameter
expansion. Not all matches are real triggers — review output manually.

### `scan-session-logs.cjs`

Count how often a bash-command pattern appears across Claude Code session
JSONL logs, and optionally inspect outcomes (errors, permission-block
text). Used to validate whether a suspected trigger actually prompts in
practice.

```sh
# How often does ${VAR:-$(...)} appear, and do any block?
node scan-session-logs.cjs ~/.claude/projects/-home-chris-project/ --inspect
```

Default pattern is `${VAR:-$(cmd)}`. Override with `--pattern='<js-regex>'`.

### `test-hook-decision.cjs`

Feed a command into the bash-safety-hook and print its decomposition plus
the allow / deny / passthrough decision. Pinpoints which sub-command
prevents an allow.

```sh
node test-hook-decision.cjs \
  --hook=path/to/.claude/hooks/bash-safety-hook.cjs \
  --cmd='node "${CLAUDE_PROJECT_DIR:-$(pwd)}/tool.cjs" foo'
```

### `verify-allowlist-parity.cjs`

After a gsd-ng install, confirm the local `.claude/settings.json` matches
`template + getPlatformCliPatterns(cli)` exactly. Flags drift (extra or
missing entries) and whether a `deny` list remains from an older install.

```sh
node verify-allowlist-parity.cjs \
  --local=.claude/settings.json \
  --template=gsd-ng/gsd-ng/templates/settings-sandbox.json \
  --allowlist-mod=gsd-ng/gsd-ng/bin/lib/allowlist.cjs
```

### `survey-bash-tool-usage.cjs`

Walk a docs/workflows directory, extract first-token commands from fenced
`` ```bash `` blocks, and report which tools are NOT in a given allowlist.
Used when planning allowlist additions.

```sh
node survey-bash-tool-usage.cjs path/to/gsd-ng/
```

Splits findings into external tools (candidates for allowlist entries) vs
shell builtins (candidates for STRUCTURAL_KEYWORDS filtering).

## Design notes

- **Why Node, not Python?** These tools interact with gsd-ng's bash-hook
  (CommonJS) and Claude Code's JSONL session logs. Staying in Node avoids
  a language-boundary copy and lets `test-hook-decision.cjs` directly
  `require()` the hook module for unit-level testing.
- **No dependencies.** Every script uses Node stdlib only. Run them
  anywhere Node ≥ 18 is available.
- **Silently skip unreadable files.** Walkers don't crash on permission
  errors, missing files, or special device files — just emit a console
  note and continue.

## See also

- `../tree-sitter-walker-regression.md` — upstream regression write-up that
  these scripts were built to investigate.
- `gsd-ng/docs/bash-safety-hook.md` — architecture of the hook these
  scripts diagnose.
