# opencode-history

Maintains a local SQLite database of session history, tracking sessions, messages, costs, token usage, and files edited. Provides a rich browsing, search, and analytics tool plus a TUI panel for navigating past sessions.

## Features

- **SQLite-backed history** (WAL mode, indexed for performance)
- **Automatic event-driven recording** — session create/update/delete, message updates, file edits, session status changes
- **Session tracking** — ID, title, directory, project, model, agent, cost, token counts, pinned status, parent/fork relationships
- **Message tracking** — role, preview, model, cost, token counts, tool calls, file attachments
- **File edit tracking** per session
- **Fork sessions** from any point (with TUI navigation)
- **Revert sessions** to a specific message
- **Export sessions** to Markdown files
- **Copy session conversations** to clipboard
- **Pin/unpin sessions** for quick access
- **Aggregate stats** — total sessions, messages, cost, tokens, files, projects
- **Activity timeline** — daily cost/token breakdown
- **Top models and agents** by usage
- **TUI plugin** — keyboard-navigable session list with fork/select/escape
- **Slash commands** — `/recent`, `/fork`

## Installation

Add the plugin to your `opencode.json`:

**From GitHub:**

```json
{
  "plugin": [
    "github:Halffd/opencode-history"
  ]
}
```

**From local path:**

```json
{
  "plugin": [
    "file:///absolute/path/to/opencode-history"
  ]
}
```

## Tool

The `history` tool is exposed with the following actions:

| Action | Description |
|--------|-------------|
| `recent` | Show recent sessions |
| `search` | Search sessions by title, directory, model, agent, or file paths |
| `session` | View a specific session |
| `messages` | View messages in a session |
| `projects` | List all projects with sessions |
| `project` | View sessions for a specific project |
| `stats` | Show aggregate usage statistics |
| `dump` | Dump session data |
| `fork` | Fork a session from a specific point |
| `continue` | Continue a previous session |
| `revert` | Revert a session to a specific message |
| `rename` | Rename a session |
| `pin` | Pin a session for quick access |
| `unpin` | Unpin a session |
| `delete` | Delete a session |
| `timeline` | Show daily activity timeline |
| `goto` | Navigate to a specific message |
| `next` | Next page of results |
| `prev` | Previous page of results |
| `copy` | Copy session conversation to clipboard |
| `export` | Export session to Markdown |
| `activity` | Show usage activity |
| `models` | Show top models by usage |
| `agents` | Show top agents by usage |
| `pinned` | List pinned sessions |

## Configuration

Options can be set in `opencode.json` under the plugin config key:

| Option | Default | Description |
|--------|---------|-------------|
| `persistPath` | `""` (auto: `~/.local/share/opencode/history/history.db`) | Custom path for the SQLite database |
| `maxMessagePreview` | `120` | Max character length for message previews |
