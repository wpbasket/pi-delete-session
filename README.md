# pi-delete-session

A powerful session deletion tool for the [Pi coding agent](https://github.com/badlogic/pi-mono). Bulk delete unwanted sessions, grouped by project, with a single command.

## Features

- **🗑️ Batch Deletion**: Delete multiple sessions in one go.
- **📁 Project Grouping**: Find sessions organized by their project folder.
- **✅ Checkbox Selection**: Multi-select sessions using an interactive list.
- **⚠️ Safety First**: Red confirmation dialog showing all selected sessions before permanent deletion.
- **🔄 Auto-Reset**: Automatically triggers a new session if you delete the one you're currently in.

## Installation

Install as a global Pi package:

```bash
pi install npm:pi-delete-session
```

Or via GitHub:

```bash
pi install git:github.com/wpbasket/pi-delete-session
```

## Usage

Type the following command in Pi:

```bash
/delete-session
```

### Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate list |
| `Space` | Toggle checkbox `[ ]` ↔ `[✓]` |
| `a` | Toggle **Select All** |
| `Enter` | Proceed to confirmation / delete |
| `Esc` | Cancel / Exit |

## Development

To install locally for development:

```bash
pi install ./path/to/pi-delete-session
```

## License

MIT
