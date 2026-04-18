# Tree-sitter bash walker regression (Claude Code v2.1.89+)

**Status:** open upstream (as of 2026-04-18, Claude Code v2.1.114)
**Applies to:** any Claude Code session with `sandbox.enabled: true` and
`autoAllowBashIfSandboxed: true`, independent of project tooling

---

## Summary

Starting with Claude Code **v2.1.89**, commands containing certain bash
syntax — parameter expansion, command substitution, grouped regex
alternation in `grep -E`, ANSI-C strings, brace expansion — trigger a
permission prompt with reasons like:

- `Contains simple_expansion`
- `Contains command_substitution`
- `Unhandled node type: string`
- `Unhandled node type: file_redirect`

These prompts appear **despite** `autoAllowBashIfSandboxed: true` being
set, and **despite** any matching entry in `permissions.allow`. The prompts
originate from Claude Code's internal tree-sitter bash static analyzer,
which runs when the sandbox layer tries to prove a command safe before
auto-allowing it. When the analyzer encounters AST node types it has no
handler for, the whole pipeline falls back to user prompting.

The prior behavior (v2.1.83 and earlier) was to auto-allow such commands
when sandboxed. The regression was introduced in 2.1.89 and remains open.

## Upstream issue references

| Issue | Scope |
|---|---|
| [#42085](https://github.com/anthropics/claude-code/issues/42085) | Regression introduced in 2.1.89 (worked in 2.1.83). `$()` command substitution and backticks trigger `Unhandled node type: string` |
| [#43713](https://github.com/anthropics/claude-code/issues/43713) | Full symptom matrix: `autoAllowBashIfSandboxed` bypassed for `simple_expansion`, `command_substitution`, `string`, `ansi_c_string`, `brace_expression` |
| [#48717](https://github.com/anthropics/claude-code/issues/48717) | Attribution: "tree-sitter bash renderer" lacks handlers for specific `string` node positions (single-quoted args, unicode in double quotes, multi-line with backslash continuation) |
| [#50030](https://github.com/anthropics/claude-code/issues/50030) | "Tool input renderer surfaces 'Unhandled node type: string' in permission prompt" — the permission walker and the input renderer appear to share the failing grammar |
| [#50144](https://github.com/anthropics/claude-code/issues/50144) | Downstream workflow disruption report |
| [#47701](https://github.com/anthropics/claude-code/issues/47701), [#47706](https://github.com/anthropics/claude-code/issues/47706), [#47752](https://github.com/anthropics/claude-code/issues/47752) | Closed prior related bugs on the "permission walker" for `file_redirect` and `pipeline` node types — suggests the tree-sitter grammar coverage has been rolling forward in patches |
| [#30435](https://github.com/anthropics/claude-code/issues/30435) | Broader request: suppressible safety heuristics via settings. Community comments document the PreToolUse-hook workaround this page references |

## Why PreToolUse hooks can't always rescue it

Claude Code's `PreToolUse` hooks can emit:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"..."}}
```

Per documented design ([#30435](https://github.com/anthropics/claude-code/issues/30435)
comments), this bypasses the safety-heuristic permission prompt. That
mechanism is what the [liberzon/claude-hooks](https://github.com/liberzon/claude-hooks)
(and its gsd-ng port at `gsd-ng/hooks/bash-safety-hook.cjs`) rely on.

**In practice, for the sandbox-analyzer path, the hook's `allow` reliably
suppresses the prompt.** Validated by scanning 67 sessions with 82 bash
tool calls containing `${VAR:-$(...)}` — zero permission blocks or walker
interruptions observed. See [Validation data](#validation-data) below.

**However**, for some specific constructs (grouped regex alternation in
`grep -E "(a|b)"`) the tree-sitter renderer also runs in the approval UI
itself and can surface error text even when the hook pre-approves —
reported as a rendering-only bug in #48717. Whether this blocks execution
or is purely cosmetic appears to vary by construct.

## The mechanism

The bash pipeline inside Claude Code has at least three tree-sitter-aware
stages, each of which can fail to parse a command and fall back to prompting:

```
           ┌─────────────────────────────┐
User runs  │ 1. Static analyzer          │──fail──► tree-sitter walker prompt
bash tool ─┼─ decide: can this run       │          ("Contains expansion",
call       │    inside sandbox, auto-    │           "Unhandled node type: string")
           │    allow candidate?         │
           ├─────────────────────────────┤──pass──► step 2
           │ 2. PreToolUse hooks         │──allow─► execute
           │    (user-supplied hooks     │
           │    can emit permission     │
           │    decision via JSON)      │
           ├─────────────────────────────┤──pass──► step 3
           │ 3. permissions.allow match  │──match─► execute
           │    against whole-command    │          (no decomposition)
           │    allowlist               │
           └─────────────────────────────┘──miss──► user prompt
```

The gsd-ng `bash-safety-hook.cjs` (step 2) intercepts commands that would
otherwise reach step 3 and approves them by decomposing on `&&`, `||`,
`;`, `|`, `$()`, and checking each sub-command against allow patterns.
This works well for the `${VAR:-$(... || pwd)}` family and any other
construct the hook's decomposer understands.

The step 1 walker is a separate pipeline — hooks don't cover it directly.
Empirically, the step 1 walker seems to be bypassed when `permissions.allow`
already covers the top-level command (e.g. `node *`) without needing
decomposition — but this isn't documented and may change.

## Trigger patterns (from #43713 repro matrix)

Confirmed to bypass `autoAllowBashIfSandboxed` on v2.1.92:

| Construct | Example | Reason shown |
|---|---|---|
| `simple_expansion` (unquoted var) | `echo $USER` | `Contains simple_expansion` |
| `string` node in some positions | `echo "$HOME"` | `Unhandled node type: string` |
| `command_substitution` | `echo $(date)` | `Contains command_substitution` |
| ANSI-C string | `echo $'hello\n'` | `Contains ansi_c_string` |
| Brace expansion | `echo {a,b,c}` | `Contains brace_expression` |
| Grouped regex in `grep -E` | `grep -E "(a\|b)" file` | `Unhandled node type: string` |
| Parameter expansion w/ subshell default | `${VAR:-$(cmd)}` | `Contains expansion` |

Some quoted forms surprisingly pass:

- `echo "$HOME/x"` — literal content plus expansion in double quotes: OK
- `echo "h=$HOME"` — literal content plus expansion: OK
- `cat <<< "hello"` — here-string with literal body: OK
- `if true; then echo y; fi` — full compound statement: OK

This suggests the grammar accepts `string` nodes in some positions (mixed
literal + expansion) but not others (pure expansion, certain escape
sequences). The exact position rules are undocumented.

## Validation data

Scan of 67 local Claude Code sessions, 4 314 total bash tool calls:

- **82** tool calls contained `${VAR:-$(cmd)}` parameter expansion with
  subshell default.
- **0** confirmed permission blocks — the 10 results matching "permission"
  or "denied" were all legitimate output text (phase descriptions mentioning
  "permissions", git log containing "denied", etc.).
- **4** `is_error` results — all unrelated execution errors (gsd-tools
  internal logic exit 1, `printf -` arg error, node script bug).

Conclusion: in current conditions (Claude Code v2.1.114, gsd-ng bash-hook
v1.0.0-dev.3, `sandbox.enabled: true`, `autoAllowBashIfSandboxed: true`),
the parameter-expansion-with-subshell-default pattern does not prompt in
practice. The bash-safety-hook's `allow` reliably covers it.

Reproducing this validation:

```sh
node scripts/scan-session-logs.cjs \
  ~/.claude/projects/<your-project-dir>/ \
  --inspect
```

## Current workarounds

Ordered from cheapest to most invasive:

1. **PreToolUse hook decomposition** — install [liberzon/claude-hooks](https://github.com/liberzon/claude-hooks)
   or the gsd-ng port. Handles most decomposable constructs (pipes, `&&`,
   `$()`, heredocs). Will not help for pure UI-rendering failures (#48717).
2. **Avoid grouped regex alternation** — rewrite `grep -E "(a|b|c)"` as
   `grep -E "a|b|c"` or expanded-anchor form `grep -E "^a|^b|^c"`.
3. **Drop dead parameter-expansion fallbacks** — in Claude Code sessions
   `CLAUDE_PROJECT_DIR` is always set, so `${CLAUDE_PROJECT_DIR:-$(git rev-parse ...)}`
   is dead code. Plain `${CLAUDE_PROJECT_DIR}` won't trigger the walker.
   Medium-scope change; revisit once the upstream fix lands.
4. **Allowlist `pwd` and other POSIX builtins** in `permissions.allow` so
   the bash-hook's decomposition can return `allow` for full commands.

## Don't restructure large codebases around this

The tree-sitter grammar coverage in #47701/47706/47752 has been rolling
forward in patches. #43713 proposes restoring the "if analyzer fails, still
check autoAllowBashIfSandboxed" pre-2.1.89 behavior. Either a grammar
update or the semantic fix makes extensive workflow rewrites obsolete. Make
surgical fixes only where a specific prompt blocks real work.

## See also

- `scripts/` — diagnostic tools referenced above
- `../../claude-performance-troubleshooting.md` — broader Claude Code
  performance/stability issues
- `gsd-ng/docs/bash-safety-hook.md` — the gsd-ng hook's architecture,
  which is designed around this regression
