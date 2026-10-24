# prompt-suggest

Ghost-text suggestion of the next prompt in the OpenCode TUI, rendered just
above the composer.

```
  next ↳ add a fourth bullet point about test naming conventions
     ctrl+x f accept  ctrl+x p refresh  ctrl+x v copy
```

## How it works

After each completed turn OpenCode asks a model what you will most likely type
next. The answer is drawn as dim text above the input.

It uses `client.generate.text`, which is a **stateless** generation call: no new
session, no tools, and nothing written to session history, so the conversation is
never polluted. Context is capped by `maxContextChars` (default 20,000) and
`maxSegmentChars` (default 4,000 per message).

Because it calls the API directly, no separate API key is needed - it uses the
provider credentials OpenCode already has. By default the suggestion is
generated with the session's currently selected model; set a cheaper one in
`config.json` via `model`.

When the conversation looks finished, the model is instructed to answer
`NONE`, and the suggestion line disappears rather than inventing busywork.

## Context priority

When the transcript exceeds the budget, content is dropped in strict priority
order, and a tier that cannot fit blocks every tier below it:

| Tier | Content                                                     |
| ---- | ----------------------------------------------------------- |
| 1    | User messages, system messages, each turn's closing message |
| 2    | Assistant narration from intermediate steps                 |
| 3    | One-line tool call summaries (`TOOL: name`)                 |
| 4    | Model reasoning (off unless `includeReasoning`)             |

So tool chatter and reasoning can never displace a user message or the message
that ended a turn. Raw tool input and output are never inlined; a tool call
contributes only its name and, when relevant, `(failed)`. Chronological order is
preserved in the final transcript.


## Keys

| Key           | Command            | What it does                            |
| ------------- | ------------------ | --------------------------------------- |
| `ctrl+x` `p`  | `prompt-suggest.refresh` | Generate or refresh the suggestion |
| `ctrl+x` `f`  | `prompt-suggest.accept`  | Send the suggestion as your prompt |
| `ctrl+x` `v`  | `prompt-suggest.copy`    | Copy the suggestion to the clipboard |

`<leader>` defaults to `ctrl+x`. Also available as `/suggest` in the prompt and
as **Suggest next prompt** in the command palette (`ctrl+p`).

> The TUI plugin API has no setter for the composer's text buffer, so a
> suggestion cannot be "tab-completed" into the input. `accept` submits it
> directly; `copy` puts it on the clipboard so you can paste and edit.

## Configuration

`config.json` beside `tui.tsx`, or `~/.config/opencode/prompt-suggest.json`
(which wins if both exist):

| Key                | Default | Meaning                                             |
| ------------------ | ------- | --------------------------------------------------- |
| `auto`             | `true`  | Suggest automatically after each completed turn     |
| `autoDelayMs`      | `900`   | Delay after a turn finishes before generating       |
| `maxMessages`      | `40`    | How many recent messages to consider                |
| `maxContextChars`  | `20000` | Hard cap on transcript characters sent              |
| `maxSegmentChars`  | `4000`  | Per-message cap so one huge reply cannot dominate   |
| `includeToolCalls` | `true`  | Include one-line tool summaries (tier 3)            |
| `includeReasoning` | `false` | Include model reasoning (tier 4)                    |
| `timeoutMs`        | `20000` | Abort a slow generation                             |
| `debug`            | `false` | Append prompt/response and budget stats to temp dir |
| `model`            | session | `{ "providerID": "...", "id": "..." }` to force one |

Set `"auto": false` to make it strictly on-demand via `ctrl+x p`.

Using a small, fast model is the main cost lever:

```json
{
  "auto": true,
  "maxContextChars": 2000,
  "model": { "providerID": "opencode-go", "id": "deepseek-v4.1-flash" }
}
```

## Install

```sh
opencode plugin add opencode-prompt-suggest
```

Or from source by copying this folder to `~/.config/opencode/plugins/prompt-suggest`,
which is discovered automatically with no config entry.

`@opentui/solid` and `solid-js` are real peer dependencies: the plugin imports
the OpenTUI JSX runtime directly so it loads correctly from `node_modules`
(where OpenCode's JSX transform is not applied). Package managers install them
automatically. `@opencode/plugin` is optional because the TUI provides it.

Configuration is read from `~/.config/opencode/prompt-suggest.json` first, then
from the bundled `config.json`, then any `options` passed in `opencode.json`.

Changes require restarting OpenCode; the plugin loads once per TUI process and
applies to every project.

