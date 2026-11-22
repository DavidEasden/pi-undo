import { diffArrays } from "diff";

const CONTEXT_LINES = 4;
// 限制 Myers 搜索深度；完全重写的文件不会在终端主线程做平方级搜索。
const MAX_EDIT_LENGTH = 512;

interface LineRun {
	readonly value: readonly string[];
	readonly added?: boolean;
	readonly removed?: boolean;
}

/** 保留换行符参与比较，文件末尾增删换行也算一行变化。 */
function linesOf(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

export function compareDiffText(before: string, after: string, includeBody = true) {
	if (before === after) return { additions: 0, deletions: 0, diff: "", simplified: false };
	const oldLines = linesOf(before);
	const newLines = linesOf(after);
	let runs: readonly LineRun[] | undefined;
	if (oldLines.length === 0) runs = [{ added: true, value: newLines }];
	else if (newLines.length === 0) runs = [{ removed: true, value: oldLines }];
	else runs = diffArrays(oldLines, newLines, { maxEditLength: MAX_EDIT_LENGTH });

	let simplified = false;
	if (runs === undefined) {
		let start = 0;
		let oldEnd = oldLines.length;
		let newEnd = newLines.length;
		while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start]) start++;
		while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
			oldEnd--;
			newEnd--;
		}
		// 单纯插入或删除仍是精确结果；两侧都有剩余时计数对应整块替换。
		simplified = start < oldEnd && start < newEnd;
		runs = [
			{ value: oldLines.slice(0, start) },
			{ removed: true, value: oldLines.slice(start, oldEnd) },
			{ added: true, value: newLines.slice(start, newEnd) },
			{ value: oldLines.slice(oldEnd) },
		].filter((run) => run.value.length > 0);
	}

	let additions = 0;
	let deletions = 0;
	for (const run of runs) {
		if (run.added) additions += run.value.length;
		if (run.removed) deletions += run.value.length;
	}
	const width = String(Math.max(oldLines.length + Number(before.endsWith("\n")),
		newLines.length + Number(after.endsWith("\n")))).length;
	return { additions, deletions, diff: includeBody ? formatRuns(runs, width) : "", simplified };
}

function formatRuns(runs: readonly LineRun[], width: number): string {
	const output: string[] = [];
	const line = (sign: string, number: number, text: string) => {
		output.push(`${sign}${String(number).padStart(width)} ${text.endsWith("\n") ? text.slice(0, -1) : text}`);
	};
	let oldNumber = 1;
	let newNumber = 1;
	for (const [index, run] of runs.entries()) {
		const lines = run.value;
		if (run.added) {
			for (const text of lines) line("+", newNumber++, text);
		} else if (run.removed) {
			for (const text of lines) line("-", oldNumber++, text);
		} else {
			const head = index > 0 ? Math.min(CONTEXT_LINES, lines.length) : 0;
			const tail = index + 1 < runs.length ? Math.max(head, lines.length - CONTEXT_LINES) : lines.length;
			for (let i = 0; i < head; i++) line(" ", oldNumber + i, lines[i]!);
			if (head < tail) output.push(` ${"".padStart(width)} ...`);
			for (let i = tail; i < lines.length; i++) line(" ", oldNumber + i, lines[i]!);
			oldNumber += lines.length;
			newNumber += lines.length;
		}
	}
	return output.join("\n");
}
