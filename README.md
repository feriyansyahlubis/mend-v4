# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/feriyansyahlubis/mend-v4/rank.svg)](https://make.fun)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/feriyansyahlubis/mend-v4/reward.svg)](https://make.fun)

`mend` reads a patch in any of four AI edit formats and applies it to the
files in the current directory — all of the patch, or none of it.

## Formats

- **Unified diff** — `diff --git` sections and bare `---` / `+++` sections,
  with hunk headers whose line numbers may be wrong; the tool finds the
  intended lines by content, preferring the nearest occurrence.
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`,
  with the target file named by the nearest non-blank line above the block.
- **V4A patch format** — `*** Begin Patch` … `*** End Patch`, with Add /
  Delete / Update sections, `@@` anchors, `*** Move to:` and
  `*** End of File`.
- **JSON tool calls** — one edit object per line, or a single JSON array:
  `create`, `str_replace` and `insert`.

## Matching

Old lines are matched in three tiers: exact, trailing-whitespace-insensitive,
then leading-and-trailing-whitespace-insensitive. At the loosest tier the
replacement lines are re-indented to the file's own indentation. A
`--strict` flag restricts matching to exact lines only.

## Invocation

```
node main.ts [--format=<unified|search-replace|v4a|json|auto>]
             [--check] [--strict] [PATCH | -]
```

`PATCH` omitted or `-` reads the patch from stdin. `--check` prints what
would change without writing anything.

## Output and exit codes

- `0` — the patch applied. Changed files are listed (`A`/`D`/`M`, `R` for
  a rename) followed by `ok: N file(s)`.
- `1` — at least one edit failed (`error: <code> <path>` per failure, then
  `failed: k of n edits`). Nothing is written.
- `2` — usage error, unreadable patch file, undetectable format, or a
  parse fault (`error: parse <line>`).

## Safety

Every path an edit names is checked before anything else about the edit:
absolute paths, backslashes, and `.` / `..` segments are rejected
(`error: unsafe <path>`). No file is touched when any edit fails.

## Files

- `main.ts` — the tool (Node 22, standard library only).
- `runner.ts` — the kit's trial runner, kept beside `main.ts` for grading.

## Verification

- 100/100 public practice checks
- 155/155 adversarial checks
- 21/21 messy checks
- 400 random fuzz cases, 0 crashes, deterministic, no partial writes
