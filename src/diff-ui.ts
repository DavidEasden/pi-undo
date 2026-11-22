import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { renderDiff } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import { buildFileLabel, type CheckpointDiff, type FileDiff, sanitizeDisplayText } from "./diff-view.ts";

const CLOSE_LABEL = "← Close";

/**
 * 在 TUI 中交互浏览一次 Agent run 的逐文件 diff：
 * 上层 select 列出改动文件，选中后用可滚动彩色查看器展示该文件 diff，返回后回到列表。
 */
export async function browseDiff(
	context: ExtensionCommandContext,
	title: string,
	view: CheckpointDiff,
	isActive: () => boolean,
): Promise<void> {
	const labels = new Map<string, CheckpointDiff["files"][number]>();
	for (const file of view.files) labels.set(uniqueLabel(buildFileLabel(file), labels), file);
	const options = [...labels.keys(), CLOSE_LABEL];
	let last: FileDiff | undefined;

	while (isActive()) {
		const choice = await context.ui.select(title, options);
		if (!isActive() || choice === undefined || choice === CLOSE_LABEL) return;
		const file = labels.get(choice);
		if (file === undefined) return;
		if (last?.path !== file.path) last = await view.loadFile(file);
		if (isActive()) await showFileDiff(context, last);
	}
}

function uniqueLabel(label: string, used: ReadonlyMap<string, unknown>): string {
	if (!used.has(label)) return label;
	let index = 2;
	while (used.has(`${label} (${index})`)) index += 1;
	return `${label} (${index})`;
}

async function showFileDiff(context: ExtensionCommandContext, diff: FileDiff): Promise<void> {
	await context.ui.custom<void>((tui, theme, _keybindings, done) => new DiffViewer(tui, theme, diff, done), {
		overlay: true,
		overlayOptions: { width: "90%", maxHeight: "90%" },
	});
}

/** 只读、可滚动的单文件 diff 查看器；不修改任何会话或存储状态。 */
class DiffViewer implements Component {
	private readonly lines: readonly string[];
	private offset = 0;
	private readonly colorVisibleLines: boolean;

	constructor(
		private readonly tui: { requestRender(force?: boolean): void },
		private readonly theme: Theme,
		private readonly diff: FileDiff,
		private readonly done: (result: void) => void,
	) {
		// 大 patch 只给视口内的行着色；超长单行跳过昂贵的词级对齐。
		this.colorVisibleLines = diff.diff.length > 32_768 || /[^\n]{1025}/.test(diff.diff);
		this.lines = this.buildLines();
	}

	invalidate(): void {}

	private buildLines(): string[] {
		if (this.diff.kind === "binary") return [this.theme.fg("dim", "Binary file changed; line-by-line diff unavailable.")];
		if (this.diff.diff === "") return [this.theme.fg("dim", "No textual change (mode or type only).")];
		return (this.colorVisibleLines ? this.diff.diff : renderDiff(this.diff.diff)).split("\n");
	}

	private viewportRows(): number {
		const rows = process.stdout.rows ?? 24;
		// 预留 overlay 边框、标题、footer 的空间。
		return Math.max(3, Math.min(this.lines.length, rows - 8));
	}

	private maxOffset(): number {
		return Math.max(0, this.lines.length - this.viewportRows());
	}

	handleInput(data: string): void {
		const rows = this.viewportRows();
		const previous = this.offset;
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "enter")) {
			this.done();
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) this.offset -= 1;
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.offset += 1;
		else if (matchesKey(data, "pageUp")) this.offset -= rows;
		else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) this.offset += rows;
		else if (matchesKey(data, "home") || matchesKey(data, "g")) this.offset = 0;
		else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) this.offset = this.maxOffset();
		this.offset = Math.max(0, Math.min(this.maxOffset(), this.offset));
		if (this.offset !== previous) this.tui.requestRender();
	}

	render(width: number): string[] {
		const rows = this.viewportRows();
		// 终端 resize 会改变 viewportRows，重绘时必须重新夹紧滚动位置。
		this.offset = Math.max(0, Math.min(this.maxOffset(), this.offset));
		const stats = this.diff.kind === "binary"
			? "binary"
			: `+${this.diff.additions} -${this.diff.deletions}${this.diff.simplified ? " (block replacement)" : ""}`;
		const safePath = sanitizeDisplayText(this.diff.path, 240);
		const header = truncateToWidth(this.theme.fg("accent", `${this.diff.status.toUpperCase()} ${safePath}`) + this.theme.fg("dim", `  ${stats}`), width);
		const out: string[] = [header, this.theme.fg("borderMuted", "─".repeat(Math.min(width, 80)))];
		const visible = this.lines.slice(this.offset, this.offset + rows);
		for (const line of visible) {
			if (this.colorVisibleLines) {
				const color = line.startsWith("-") ? "toolDiffRemoved" : line.startsWith("+") ? "toolDiffAdded" : "toolDiffContext";
				out.push(this.theme.fg(color, truncateToWidth(line.replace(/\t/g, "   "), width)));
			} else {
				out.push(truncateToWidth(line, width));
			}
		}
		for (let index = visible.length; index < rows; index += 1) out.push("");
		const position = this.lines.length <= rows
			? "all"
			: `${this.offset + 1}-${Math.min(this.offset + rows, this.lines.length)}/${this.lines.length}`;
		out.push(this.theme.fg("dim", `↑↓/PgUp/PgDn scroll · ${position} · Esc/q close`));
		return out;
	}
}
