# pi-delete-session

A professional multi-select session manager for the [Pi coding agent](https://github.com/badlogic/pi-mono). Clean up your session history with ease, grouping by project and deleting in batches.

## Features

- **📁 Project Grouping**: Browse sessions organized by their project folder.
- **✅ Multi-Select**: Use checkboxes to select multiple sessions at once.
- **🚀 Batch Actions**: Select All (**a**) or individual sessions (**Space**) to delete in one go.
- **⚠️ Safety First**: Red confirmation dialog showing all selected sessions before permanent deletion.
- **🔄 Auto-Reset**: Automatically triggers a new session if you delete the one you're currently in.

## Installation

Install as a global Pi package:

```bash
pi install npm:pi-delete-session
```

Or via GitHub:

```bash
pi install git:github.com/YOUR_USERNAME/pi-delete-session
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
