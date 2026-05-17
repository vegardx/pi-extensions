# pi-ext-editor

`/editor [path[:line[:col]]]` — open the configured IDE/editor.

- `/editor` opens the session cwd.
- `/editor src/foo.ts` opens that file.
- `/editor src/foo.ts:42` jumps to line 42.
- `/editor src/foo.ts:42:8` jumps to line 42, column 8.

Spawns detached + unref'd by default, so closing pi doesn't kill the editor.

## Configuration

Under `extensionConfig.editor` in `~/.pi/agent/<repo>/settings.json` (or the
host-level config that pi merges). Default behaviour: launch `code` with the
single argument `{path}`.

| Key | Type | Default | Notes |
|---|---|---|---|
| `command` | `string` | `$VISUAL` ?? `$EDITOR` ?? `"code"` | Executable to launch. Must be on `PATH`. |
| `args` | `string[]` | `["{path}"]` | Argv template. Placeholders: `{path}`, `{cwd}`, `{line}`, `{col}`. |
| `detach` | `boolean` | `true` | Detach + `unref()` so pi can exit independently. |

Path arg accepts `path`, `path:line`, `path:line:col`. A leading `~/`
(or bare `~`) expands to your home directory.

### Placeholders & empty values

`{path}` always resolves (to a file or the cwd). `{line}` / `{col}` are empty
when the user didn't pass them. The substitution is wired so missing values
don't break argv:

- An arg whose placeholders all resolved empty is dropped (with the preceding
  `-x` / `--xxx` flag, if any).
- Trailing `:` runs are trimmed when the trailing placeholder resolved empty.
- **Caveat — flag-drop ambiguity**: the rule above can't distinguish a
  *value-introducer* flag (`--line {line}`) from a *standalone* flag
  that happens to sit immediately before a dropped placeholder.
  `["--wait", "--line", "{line}", "{path}"]` will drop the standalone
  `--wait` when `{line}` is empty because it's the immediate
  predecessor of the dropped value. If you need a standalone flag
  near a placeholder pair, put it after the value or in its own arg
  (`["--wait=true", "--line", "{line}", "{path}"]`).

So `["-g", "{path}:{line}:{col}"]` becomes `-g <path>` for `/editor foo.ts`,
`-g <path>:42` for `/editor foo.ts:42`, and `-g <path>:42:8` for the full form.

### Examples

VS Code:

```json
{ "extensionConfig": { "editor": {
  "command": "code",
  "args": ["-g", "{path}:{line}:{col}"]
} } }
```

Cursor:

```json
{ "extensionConfig": { "editor": {
  "command": "cursor",
  "args": ["-g", "{path}:{line}"]
} } }
```

IntelliJ / WebStorm / etc.:

```json
{ "extensionConfig": { "editor": {
  "command": "idea",
  "args": ["--line", "{line}", "{path}"]
} } }
```

Neovim in a new tmux window:

```json
{ "extensionConfig": { "editor": {
  "command": "tmux",
  "args": ["new-window", "nvim", "+{line}", "{path}"]
} } }
```

Sublime Text:

```json
{ "extensionConfig": { "editor": {
  "command": "subl",
  "args": ["{path}:{line}:{col}"]
} } }
```

## Path syntax

The `:line` / `:col` segments are only peeled when each is purely digits.
`Makefile:foo` stays a literal path; `weird:42:not-col` does too. Relative
paths resolve against the session cwd; absolute paths pass through.

## PATH miss

When the configured command isn't on `PATH`, pi notifies with the failing
command and a hint to set `extensionConfig.editor.command` or `$VISUAL` /
`$EDITOR`. The notification is surfaced via `ctx.ui.notify(..., "warning")`.

## Install

```bash
pi -e ./packages/editor
```
