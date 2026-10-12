import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, Text, SelectList, type SelectItem, matchesKey, Key, type KeyId } from "@earendil-works/pi-tui";
import { stat, unlink } from "node:fs/promises";
import { basename } from "node:path";

type CommandContext = ExtensionCommandContext;

// ── Types ─────────────────────────────────────────────────────────────────────

interface SessionDisplay {
  path: string;
  name: string;
  cwd: string;
  messageCount: number;
  modified: Date;
  size?: number;
}

interface SelectableSession extends SessionDisplay {
  selected: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeMatchesKey(data: string, key: KeyId): boolean {
  try {
    return matchesKey(data, key);
  } catch {
    return false;
  }
}

function matchesAnyKey(data: string, key: KeyId, fallbacks: string[] = []): boolean {
  return data === key || safeMatchesKey(data, key) || fallbacks.includes(data);
}

function isDownKey(data: string): boolean {
  return matchesAnyKey(data, Key.down, ["down", "\x1b[B", "\x1bOB"]);
}

function isUpKey(data: string): boolean {
  return matchesAnyKey(data, Key.up, ["up", "\x1b[A", "\x1bOA"]);
}

function isEnterKey(data: string): boolean {
  return matchesAnyKey(data, Key.enter, ["enter", "return", "\r", "\n"]);
}

function isEscapeKey(data: string): boolean {
  return matchesAnyKey(data, Key.escape, [Key.esc, "escape", "esc", "\x1b"]);
}

function isSpaceKey(data: string): boolean {
  return matchesAnyKey(data, Key.space, ["space", " "]);
}

function normalizeSelectListInput(data: string): string {
  if (isDownKey(data)) return "\x1b[B";
  if (isUpKey(data)) return "\x1b[A";
  if (isEnterKey(data)) return "\r";
  if (isEscapeKey(data)) return "\x1b";
  if (isSpaceKey(data)) return " ";
  return data;
}

// ── Session listing ─────────────────────────────────────────────────────────
// Uses the public SessionManager.list()/listAll() APIs (sorted newest-first)
// instead of hand-rolled directory scans, so session discovery always matches
// pi's own session layout and header parsing. Each command invocation re-lists
// from disk, so there is no stale-cache concern.
async function loadSessions(scope: "cwd" | "all", cwd: string): Promise<SessionDisplay[]> {
  const infos = scope === "cwd"
    ? await SessionManager.list(cwd)
    : await SessionManager.listAll();
  const sessions: SessionDisplay[] = infos.map((info) => ({
    path: info.path,
    name: info.name?.trim() || info.firstMessage.slice(0, 60) || "(unnamed)",
    cwd: info.cwd,
    messageCount: info.messageCount,
    modified: info.modified,
  }));
  // Sizes are best-effort display metadata (not part of SessionInfo).
  await Promise.all(sessions.map(async (s) => {
    s.size = await sessionFileSize(s.path);
  }));
  return sessions;
}

async function sessionFileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Multi-select session picker with checkboxes ────────────────────────────
  async function multiSelectSessions(
    ctx: CommandContext,
    sessions: SessionDisplay[],
    titleLabel: string
  ): Promise<string[]> {
    if (sessions.length === 0) return [];

    const items: SelectableSession[] = sessions.map((s) => ({ ...s, selected: false }));
    let cursor = 0;
    let scrollOffset = 0;

    const result = await ctx.ui.custom<string[]>((tui: any, theme: any, _kb: any, done: (v: string[]) => void) => {
      const container = new Container();

      const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
      const title = new Text(theme.fg("accent", theme.bold(` ${titleLabel} (${sessions.length}) `)), 1, 0);
      const help1 = new Text(theme.fg("dim", " ↑↓ - navigate | space - toggle | a - all | enter - delete | esc - cancel "), 1, 0);
      const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));

      container.addChild(topBorder);
      container.addChild(title);
      container.addChild(new Text("\x1b[0m", 1, 0));

      const rowComponents: Text[] = [];
      const visibleRows = Math.min(sessions.length, 12);
      for (let i = 0; i < visibleRows; i++) {
        const rowText = new Text("", 0, 0);
        rowComponents.push(rowText);
        container.addChild(rowText);
      }

      container.addChild(new Text("\x1b[0m", 1, 0));
      container.addChild(help1);
      container.addChild(bottomBorder);

      function renderRows(width: number) {
        const visibleCount = Math.min(items.length, 12);
        for (let i = 0; i < visibleCount; i++) {
          const itemIdx = scrollOffset + i;
          const s = items[itemIdx];
          if (!s) { rowComponents[i].setText(""); continue; }

          const isCursor = itemIdx === cursor;
          const checkbox = s.selected ? theme.fg("success", "[✓]") : "[ ]";
          const name = (s.name.length > 48 ? s.name.slice(0, 48) + "…" : s.name) || "(empty)";
          const meta = `${s.messageCount} msgs, ${formatDate(s.modified)}, ${formatBytes(s.size ?? 0)}`;

          const cursorIndicator = isCursor ? theme.fg("success", "▸ ") : "  ";
          const namePadded = name.padEnd(52, " ");
          const nameStyled = isCursor ? theme.fg("success", theme.bold(namePadded)) : namePadded;
          const metaStyled = isCursor ? theme.fg("success", `(${meta})`) : `(${meta})`;
          rowComponents[i].setText(`${cursorIndicator}${checkbox} ${nameStyled}${metaStyled}`);
        }
      }

      function clampScroll() {
        const visibleCount = Math.min(items.length, 12);
        if (cursor < scrollOffset) scrollOffset = cursor;
        if (cursor >= scrollOffset + visibleCount) scrollOffset = cursor - visibleCount + 1;
        scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, items.length - visibleCount)));
      }

      return {
        render: (w: number) => { renderRows(w); return container.render(w); },
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (isDownKey(data)) { cursor = Math.min(cursor + 1, items.length - 1); clampScroll(); }
          else if (isUpKey(data)) { cursor = Math.max(cursor - 1, 0); clampScroll(); }
          else if (isSpaceKey(data)) { items[cursor].selected = !items[cursor].selected; }
          else if (data === "a" || data === "A") {
            const allSelected = items.every(s => s.selected);
            for (const s of items) s.selected = !allSelected;
          }
          else if (isEnterKey(data)) {
            const selected = items.filter((s) => s.selected).map((s) => s.path);
            done(selected);
          } else if (isEscapeKey(data)) {
            done([]);
          }
          tui.requestRender();
        },
      };
    });
    return result ?? [];
  }

  // ── Red confirmation ───────────────────────────────────────────────────────
  async function confirmBatchDelete(ctx: CommandContext, selectedPaths: string[], sessions: SessionDisplay[]): Promise<boolean> {
    const names = selectedPaths
      .map((p) => sessions.find((s) => s.path === p)?.name ?? p)
      .map((n) => (n.length > 50 ? n.slice(0, 50) + "…" : n));

    return ctx.ui.custom<boolean>((tui: any, theme: any, _kb: any, done: (v: boolean) => void) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("error", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold(" ☠️  DELETE SELECTED SESSIONS ")), 1, 0));
      container.addChild(new Text(theme.fg("error", `You are about to delete ${selectedPaths.length} session(s):`), 1, 0));
      container.addChild(new Text("", 1, 0));
      for (const name of names.slice(0, 8)) { container.addChild(new Text(`  • ${name}`, 1, 0)); }
      if (names.length > 8) { container.addChild(new Text(theme.fg("muted", `  … and ${names.length - 8} more`), 1, 0)); }
      container.addChild(new Text("", 1, 0));
      container.addChild(new Text(theme.fg("error", "This permanently removes these session files.") + " " + theme.fg("error", "Cannot be undone."), 1, 0));
      container.addChild(new Text("", 1, 0));
      container.addChild(new Text(theme.fg("success", theme.bold("Enter")) + " to confirm  |  " + theme.fg("muted", "Esc") + " to cancel", 1, 0));
      container.addChild(new DynamicBorder((s: string) => theme.fg("error", s)));

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (isEnterKey(data)) { done(true); return; }
          if (isEscapeKey(data)) { done(false); return; }
          tui.requestRender();
        },
      };
    });
  }

  // ── Project Picker ─────────────────────────────────────────────────────────
  async function pickProject(ctx: CommandContext, sessions: SessionDisplay[]): Promise<string | null> {
    const projects = new Map<string, SessionDisplay[]>();
    for (const s of sessions) {
      const list = projects.get(s.cwd) || [];
      list.push(s);
      projects.set(s.cwd, list);
    }

    const items: SelectItem[] = Array.from(projects.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .map(([cwd, list]) => ({
        value: cwd,
        label: `📁 ${basename(cwd)}`,
        description: `${list.length} sessions  •  ${cwd}`,
      }));

    return ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (v: string | null) => void) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold(` Select Project (${items.length} folders found) `)), 1, 0));

      const selectList = new SelectList(items, Math.min(items.length, 15), {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      });
      selectList.onSelect = (item) => done(item.value as string);
      selectList.onCancel = () => done(null);
      container.addChild(selectList);

      container.addChild(new Text(theme.fg("dim", " ↑↓ navigate • enter select • esc cancel "), 1, 0));
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (isEscapeKey(data)) { done(null); return; }
          selectList.handleInput(normalizeSelectListInput(data));
          tui.requestRender();
        },
      };
    });
  }

  // ── Scope Picker ───────────────────────────────────────────────────────────
  async function pickScope(ctx: CommandContext): Promise<"cwd" | "all" | null> {
    const scopeItems = [
      { value: "cwd", label: "📁 This Project", description: ctx.cwd },
      { value: "all", label: "🌍 Other Projects", description: "Select from all project folders" },
    ];

    return ctx.ui.custom<"cwd" | "all" | null>((tui: any, theme: any, _kb: any, done: (v: "cwd" | "all" | null) => void) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold(" Delete Session — Select Scope ")), 1, 0));

      let cursor = 0;
      const help = new Text(theme.fg("dim", " ↑↓ navigate • enter select • esc cancel "), 1, 0);

      const renderMenu = () => {
        return scopeItems.map((item, idx) => {
          const arrow = idx === cursor ? theme.fg("accent", "▸ ") : "  ";
          const label = idx === cursor ? theme.fg("accent", theme.bold(item.label)) : theme.fg("muted", item.label);
          return `${arrow}${label} ${theme.fg("dim", `(${item.description})`)}`;
        });
      };

      const menuText = new Text("", 1, 0);
      container.addChild(menuText);
      container.addChild(help);
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      return {
        render: (w: number) => { menuText.setText("\n" + renderMenu().join("\n\n") + "\n"); return container.render(w); },
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (isDownKey(data)) cursor = Math.min(cursor + 1, 1);
          else if (isUpKey(data)) cursor = Math.max(cursor - 1, 0);
          else if (isEnterKey(data)) { done(scopeItems[cursor].value as any); }
          else if (isEscapeKey(data)) { done(null); }
          tui.requestRender();
        },
      };
    });
  }

  // ── Main command ────────────────────────────────────────────────────────────
  async function runManager(ctx: CommandContext) {
    const scope = await pickScope(ctx);
    if (!scope) return;

    let targetSessions: SessionDisplay[] = [];
    let title = "";

    if (scope === "cwd") {
      ctx.ui.notify("Loading sessions for this project…", "info");
      targetSessions = await loadSessions("cwd", ctx.cwd);
      title = `Sessions: ${basename(ctx.cwd)}`;
    } else {
      ctx.ui.notify("Scanning all projects…", "info");
      const allSessions = await loadSessions("all", ctx.cwd);
      const selectedCwd = await pickProject(ctx, allSessions);
      if (!selectedCwd) return;
      targetSessions = allSessions.filter(s => s.cwd === selectedCwd);
      title = `Sessions: ${basename(selectedCwd)}`;
    }

    if (targetSessions.length === 0) {
      ctx.ui.notify("No sessions found.", "warning");
      return;
    }

    const selectedPaths = await multiSelectSessions(ctx, targetSessions, title);
    if (selectedPaths.length === 0) return;

    const confirmed = await confirmBatchDelete(ctx, selectedPaths, targetSessions);
    if (!confirmed) return;

    let deleted = 0;
    const currentSession = ctx.sessionManager.getSessionFile();
    let currentDeleted = false;

    for (const path of selectedPaths) {
      try {
        await unlink(path);
        deleted++;
        if (path === currentSession) currentDeleted = true;
      } catch (err: any) {
        ctx.ui.notify(`Error: ${err.message}`, "error");
      }
    }

    if (currentDeleted) {
      await ctx.newSession({
        withSession: async (newCtx) => {
          newCtx.ui.notify(`Active session deleted. Started new session. Deleted ${deleted} session(s).`, "info");
        },
      });
    } else {
      ctx.ui.notify(`Deleted ${deleted} session(s).`, "info");
    }
  }

  pi.registerCommand("delete-session", {
    description: "Delete sessions with project grouping and multi-select.",
    handler: async (_args, ctx) => runManager(ctx),
  });

}
