# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/alprasta/makefun-hidden-spec-cli-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/alprasta/makefun-hidden-spec-cli-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files.
The model may write the edit in any of four formats — a unified diff,
SEARCH/REPLACE blocks, the V4A patch format, or text-editor tool calls
as JSON — and `mend` reads whichever one it is given, applies it to
the files under the working directory, and either writes every change
or, if any edit failed, writes nothing at all.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working
  directory. When it is absent or is `-`, the patch is read from
  standard input. The working directory is the root of the tree, and
  every path in a patch is relative to it.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`. With `auto` (the default) the
  format is detected from the patch text.
- `--check` does everything but write: the same output and exit code
  as without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only; see below).
- Options and `PATCH` may come in any order. `--` ends the options:
  every argument after it is a positional argument.

## Output and exit codes

Standard output holds lines, each ended by `\n`, and nothing else.

- Exit 2, exactly one line: `error: usage` (bad arguments),
  `error: no-patch` (the patch file cannot be read),
  `error: format` (`--format=auto` detected no format), or
  `error: parse <N>` (the patch cannot be read in its format;
  `<N>` is the 1-based patch line named in the specification, and a
  patch holding no edit at all is `error: parse 1`). They are tried
  in that order: usage beats no-patch, which beats format, which
  beats parse, and a parse error is reported before any file is
  looked at.
- Exit 1: one line `error: <code> <path>` for each edit that failed,
  in the patch's order, then `failed: <k> of <n> edits`. The codes
  are `no-match` (the lines or text are not in the file),
  `ambiguous` (there more than once with no way to choose),
  `missing` (the file to change, delete or move does not exist),
  `exists` (the file to create, or the target of a move, exists) and
  `unsafe` (a path is not a safe path). When any edit failed, no
  file is written, but the edits after a failed one still run, so
  every failure is reported.
- Exit 0: one line for each path whose state changed, in byte order
  of the paths (UTF-8), then `ok: <n> files` (or `ok: 1 file`).
  `A <path>` created it, `D <path>` deleted it, `M <path>` changed
  its bytes, and `R <old> -> <new>` records a move, replacing that
  pair's `D` and `A` lines and sorting by `<new>`. A file whose bytes
  are unchanged is not listed; a patch that changes nothing prints
  only `ok: 0 files`.

## Files, lines and paths

Files and patches are UTF-8 text. A path is safe when it is not
empty, does not start with `/`, holds no `\`, and none of its
`/`-separated segments is empty, `.` or `..`. Directories are
created as files need them.

A file's line break is CRLF when its first line feed follows a
carriage return, and LF otherwise. A changed file is written back
with its own line break between its lines, and with a final one
exactly when it ended with one before the edit (a unified hunk may
change that, see below). A file an edit creates is written with LF
breaks and ends with a line break, unless the edit's format says
otherwise; a JSON `create` writes its `file_text` byte for byte.

## Matching lines

Unified hunks, SEARCH/REPLACE blocks and V4A chunks name old lines
`O` that are replaced by new lines `N`. `O` is found in the file's
current lines at the first of three tiers at which it occurs at
least once:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed
  from both;
- tier 2: every line equal once leading and trailing spaces and tabs
  are removed from both.

With `--strict` only tier 0 is tried. When `O` occurs at no tier the
edit fails with `no-match`. A context line (a line of both `O` and
`N` in a unified hunk or a V4A chunk) is written as the file's own
matched line, never the patch's. At tier 2 every other line of `N`
is re-indented: the leading whitespace of `O`'s first line is
replaced by the leading whitespace of the file's first matched line
(including when `O`'s first line has no leading whitespace, in which
case the file's indent is prepended).

## The four formats

### Unified diffs

Sections start at `diff --git a/<X> b/<Y>` or at a `--- ` line
followed by a `+++ ` line. `---`/`+++` name the old and new path
(the text after the four characters, up to the first tab, with
surrounding spaces removed; `/dev/null` means no file; a leading
`a/` or `b/` is removed). `rename from`/`rename to` name the paths
when no `---`/`+++` pair does, and the `diff --git` paths are used
when nothing else names one. `new file mode` makes a section a
creation, `deleted file mode` a deletion; other header lines are
ignored, and prose outside hunks is ignored.

Each section is one edit: a creation (old path `/dev/null`, or
`new file mode`) is the `+` lines of all its hunks; a deletion
(new path `/dev/null`, or `deleted file mode`) deletes the old path
and its hunks are not read; a move (old and new path differ) applies
the hunks to the old file and writes the result at the new path;
otherwise the one path is changed. Hunks apply in order, each to
the result of the ones before it. When `O` is not empty, the hunk
takes the occurrence nearest to `A - 1 + d`, where `d` is the sum
over the section's hunks applied so far of (`N`'s length minus
`O`'s length), the earlier of two equally near. When `O` is empty,
`N` is inserted after the first `A + d` lines. A `\` line (as in
`\ No newline at end of file`) refers to the body line before it:
when a hunk's matched lines run to the end of the file (or, for an
empty `O`, the insertion is at the end), the result ends with a
line break unless a `\` line follows the hunk's last context or
`+` line; otherwise the file's final break stays as it was. A
created file ends with a line break unless a `\` line follows its
last `+` line.

### SEARCH/REPLACE blocks

```
<path>
<<<<<<< SEARCH
<old lines>
=======
<new lines>
>>>>>>> REPLACE
```

The path is the nearest line before the `<<<<<<< SEARCH` line, and
after the previous block's `>>>>>>> REPLACE` line (or the start of
the patch), that is not blank and does not start with three
backticks; when there is no such line the block takes the previous
block's path. Each block is one edit: empty old lines create the
file with the new lines, otherwise the file must exist and the old
lines must occur at their tier exactly once, or the block fails
with `ambiguous`.

### V4A patches

```
*** Begin Patch
*** Add File: <path>
+<line>
*** Delete File: <path>
*** Update File: <path>
*** Move to: <new path>
@@ <anchor>
 <context>
-<old>
+<new>
*** End of File
*** End Patch
```

Each section is one edit. Add creates the file with the section's
lines, ended by a line break; Delete deletes the file; Update
applies its chunks in order with a cursor that starts at line 0.
A chunk with an anchor first finds the first line at or after the
cursor equal to the anchor at the first tier where one is, and the
cursor moves past it. The chunk then takes the first occurrence of
`O` at or after the cursor at the first tier with one; an
end-of-file chunk takes only an occurrence ending at the file's
last line. When `O` is empty, `N` is inserted at the cursor, or at
the end of the file for an end-of-file chunk. The cursor then moves
to just after the lines written. With `*** Move to:`, the result is
written at the new path and the old path deleted. Blank lines at
the end of a section are not part of it.

### JSON edits

The patch is either one JSON array of edit objects, or JSON Lines
(one edit object a line; blank lines ignored). An edit object has
a string `path` and a `command`; other keys are ignored.

- `{"command": "create", "path", "file_text"}` — the file must not
  exist; it is written with `file_text`'s bytes.
- `{"command": "str_replace", "path", "old_str", "new_str"}` —
  `old_str` a non-empty string, `new_str` a string (absent is
  empty). The file must exist. In a CRLF file the file's text and
  both strings are read with every `\r\n` as `\n`, and the result
  is written back with `\r\n`. `old_str` must occur in the text
  exactly once (positions may overlap), else `no-match` or
  `ambiguous`; the match is exact, no tier applies.
- `{"command": "insert", "path", "insert_line", "new_str"}` —
  `insert_line` an integer from 0 to the file's number of lines
  (else `no-match`). `new_str`'s lines are inserted after line
  `insert_line` (0 is the top); the file's final break stays as it
  was.

A wrong command or a missing or mistyped key is a parse fault: in
array form, `error: parse <the line where the array starts>`; in
JSON Lines form, `error: parse <that line>`.

## Order and atomicity

Edits apply in the patch's order to the tree as earlier edits left
it: a file created, changed, moved or deleted by an earlier edit is
seen so by a later one. Every path an edit names is checked for
safety before anything else about it. A failed edit changes
nothing, and the edits after it still run. When any edit failed,
no file is written (exit 1). When none failed, every change is
written (exit 0), or with `--check` none is.

## Running it

Node 22, standard library only, no dependencies to install:

```
node main.ts --help        # not a supported option; prints error: usage
node main.ts patch.diff
cat patch.diff | node main.ts
node main.ts --format=json --check edits.jsonl
```

The practice set in this directory is graded with
`node check.ts practice.json`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
