import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Text, SelectList, type SelectItem } from "@mariozechner/pi-tui";
import { unlink, stat } from "node:fs/promises";
import { basename } from "node:path";

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

async function getFileSize(path: string): Promise<number | undefined> {
  try { const s = await stat(path); return s.size; } catch { return undefined; }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadSessions(scope: "cwd" | "all", cwd: string): Promise<SessionDisplay[]> {
  const raw = scope === "cwd" ? await SessionManager.list(cwd) : await SessionManager.listAll();
  const enriched = await Promise.all(
    raw.map(async (s) => ({
      path: s.path,
      name: s.name || s.firstMessage.slice(0, 60) || "(unnamed)",
      cwd: s.cwd,
      messageCount: s.messageCount,
      modified: s.modified,
      size: await getFileSize(s.path),
    }))
  );
  return enriched.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── Multi-select session picker with checkboxes ────────────────────────────
  async function multiSelectSessions(
    ctx: any,
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
      const title = new Text(theme.fg("accent", theme.bold(` ${titleLabel} (${sessions.length} sessions) `)), 1, 0);
      const help1 = new Text(theme.fg("dim", " ↑↓ navigate • Space toggle • a toggle all • Enter delete selected • Esc cancel "), 1, 0);
      const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));

      container.addChild(topBorder);
      container.addChild(title);

      const rowComponents: Text[] = [];
      const visibleRows = Math.min(sessions.length, 12);
      for (let i = 0; i < visibleRows; i++) {
        const rowText = new Text("", 0, 0);
        rowComponents.push(rowText);
        container.addChild(rowText);
      }

      const statusLine = new Text("", 1, 0);
      container.addChild(statusLine);
      container.addChild(help1);
      container.addChild(bottomBorder);

      function renderRows(width: number) {
        const visibleCount = Math.min(items.length, 12);
        for (let i = 0; i < visibleCount; i++) {
          const itemIdx = scrollOffset + i;
          const s = items[itemIdx];
          if (!s) { rowComponents[i].setText(""); continue; }

          const isCursor = itemIdx === cursor;
          const checkbox = s.selected ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
          const name = (s.name.length > 42 ? s.name.slice(0, 42) + "…" : s.name) || "(empty)";
          const meta = `${s.messageCount} msgs • ${formatDate(s.modified)} • ${formatBytes(s.size ?? 0)}`;

          const cursorIndicator = isCursor ? theme.fg("accent", "▸ ") : "  ";
          const nameStyled = isCursor ? theme.fg("accent", theme.bold(name)) : theme.fg("muted", name);
          const metaStyled = theme.fg("muted", meta);
          rowComponents[i].setText(`${cursorIndicator}${checkbox} ${nameStyled}  ${metaStyled}`);
        }

        const selectedCount = items.filter((s) => s.selected).length;
        statusLine.setText(
          theme.fg("muted", `Selected: `)
            + (selectedCount > 0 ? theme.fg("success", `${selectedCount}`) : theme.fg("dim", "0"))
            + theme.fg("muted", ` / ${items.length}`)
        );
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
          if (data === "down" || data === "\x1b[B") { cursor = Math.min(cursor + 1, items.length - 1); clampScroll(); }
          else if (data === "up" || data === "\x1b[A") { cursor = Math.max(cursor - 1, 0); clampScroll(); }
          else if (data === " " || data === "space") { items[cursor].selected = !items[cursor].selected; }
          else if (data === "a" || data === "A") {
            const allSelected = items.every(s => s.selected);
            for (const s of items) s.selected = !allSelected;
          }
          else if (data === "return" || data === "\r" || data === "\n") {
            const selected = items.filter((s) => s.selected).map((s) => s.path);
            done(selected);
          } else if (data === "escape" || data === "\x1b") {
            done([]);
          }
          tui.requestRender();
        },
      };
    });
    return result ?? [];
  }

  // ── Red confirmation ───────────────────────────────────────────────────────
  async function confirmBatchDelete(ctx: any, selectedPaths: string[], sessions: SessionDisplay[]): Promise<boolean> {
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
          if (data === "return" || data === "\r" || data === "\n") { done(true); return; }
          if (data === "escape" || data === "\x1b") { done(false); return; }
          tui.requestRender();
        },
      };
    });
  }

  // ── Project Picker ─────────────────────────────────────────────────────────
  async function pickProject(ctx: any, sessions: SessionDisplay[]): Promise<string | null> {
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
          if (data === "escape" || data === "\x1b") { done(null); return; }
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  // ── Scope Picker ───────────────────────────────────────────────────────────
  async function pickScope(ctx: any): Promise<"cwd" | "all" | null> {
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
          if (data === "down" || data === "\x1b[B") cursor = Math.min(cursor + 1, 1);
          else if (data === "up" || data === "\x1b[A") cursor = Math.max(cursor - 1, 0);
          else if (data === "return" || data === "\r" || data === "\n") { done(scopeItems[cursor].value as any); }
          else if (data === "escape" || data === "\x1b") { done(null); }
          tui.requestRender();
        },
      };
    });
  }

  // ── Main command ────────────────────────────────────────────────────────────
  async function runManager(ctx: ExtensionContext) {
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
      ctx.ui.notify(`Active session deleted. Starting new session...`, "info");
      await ctx.newSession();
    } else {
      ctx.ui.notify(`Deleted ${deleted} session(s).`, "success");
    }
  }

  pi.registerCommand("delete-session", {
    description: "Delete sessions with project grouping and multi-select.",
    handler: async (_args, ctx) => runManager(ctx),
  });

}
