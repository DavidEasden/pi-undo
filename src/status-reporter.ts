import type { OperationResult } from "./controller.ts";

export type RefillResult = "written" | "skipped" | "requested" | "unsupported";

export interface StatusContext {
	readonly mode: "tui" | "rpc" | "print" | "json";
	readonly ui: {
		setStatus(key: string, text: string | undefined): void;
		notify(message: string, type?: "info" | "warning" | "error" | string): void;
		getEditorText(): string;
		setEditorText(text: string): void;
	};
}

/** 统一管理 footer、通知与 prompt 回填，避免状态文本泄露运行时细节。 */
export class StatusReporter {
	private readonly context: StatusContext;
	private progress: { opId: string; phase: string; started: number } | undefined;
	private progressTimer: ReturnType<typeof setInterval> | undefined;

	constructor(context: StatusContext) {
		this.context = context;
	}

	startOperation(opId: string): void {
		this.endOperation();
		this.progress = { opId, phase: "等待检查点", started: Date.now() };
		this.progressTimer = setInterval(() => this.renderProgress(), 1_000);
		this.progressTimer.unref();
	}

	setOperationPhase(phase: string): void {
		if (this.progress === undefined) return;
		this.progress.phase = phase;
	}

	endOperation(): void {
		if (this.progressTimer !== undefined) clearInterval(this.progressTimer);
		this.progressTimer = undefined;
		this.progress = undefined;
	}

	private renderProgress(): void {
		const progress = this.progress;
		if (progress === undefined) return;
		const scanned = /^scan_directories:(\d+)$/.exec(progress.phase)?.[1];
		const label = scanned !== undefined ? `扫描目录 ${scanned}`
			: progress.phase.startsWith("discover_roots") ? "扫描目录" : phaseLabels[progress.phase] ?? progress.phase;
		this.setStatus(`${label} ${Math.floor((Date.now() - progress.started) / 1_000)}s op:${progress.opId}`);
	}

	setReady(undoCount: number, redoCount: number): void {
		this.setStatus(`ready undo:${undoCount} redo:${redoCount}`);
	}

	setPhase(text: string): void {
		this.setStatus(sanitize(text));
	}

	setRecoveryRequired(
		reason: string,
		details?: { readonly files?: number; readonly opId?: string },
	): void {
		const safeReason = sanitize(reason) || "recovery_required";
		if (details?.files !== undefined && details.opId !== undefined) {
			this.setStatus(`recovery_required reason:${safeReason} files:${details.files} op:${sanitize(details.opId)}`);
			return;
		}
		this.setStatus(`recovery required: ${safeReason}`);
	}

	clear(): void {
		this.endOperation();
		this.context.ui.setStatus("pi-undo", undefined);
	}

	result(result: OperationResult, totalMs?: number): void {
		const opId = this.progress?.opId;
		this.endOperation();
		const details = result.message === undefined ? "" : ` ${sanitize(result.message)}`;
		const workload = settlementWorkload(result.settlement, result.code !== "ok" && result.code !== "noop");
		const elapsedMs = totalMs ?? 0;
		const settlementMs = result.settlement?.durationMs ?? 0;
		const timing = elapsedMs >= 1_000
			? formatTiming(elapsedMs, result.timings)
			: settlementMs >= 1_000 ? formatTiming(settlementMs, result.timings, "settled") : "";
		const diagnostic = opId !== undefined && (result.code !== "ok" || elapsedMs >= 1_000) ? ` op:${opId}` : "";
		const message = sanitize(`${result.code} files:${result.changedFiles}${details}${workload}${timing}${diagnostic}`);
		const type = result.code === "ok" || result.code === "noop"
			? "info"
			: result.code === "recovery_required" ? "error" : "warning";
		this.context.ui.notify(message, type);
	}

	refillPrompt(text: string): RefillResult {
		if (this.context.mode === "print" || this.context.mode === "json") return "unsupported";
		if (this.context.mode === "rpc") {
			this.context.ui.setEditorText(text);
			return "requested";
		}
		if (this.context.ui.getEditorText().length > 0) return "skipped";
		this.context.ui.setEditorText(text);
		return this.context.ui.getEditorText() === text ? "written" : "skipped";
	}

	private setStatus(text: string): void {
		this.context.ui.setStatus("pi-undo", sanitize(text));
	}
}

const phaseLabels: Record<string, string> = {
	idle: "等待 Agent 停止", checkpoint: "等待检查点", lock: "等待工作区锁",
	capture: "捕获安全快照", load: "读取快照", plan: "准备恢复", journal: "记录事务",
	navigate: "切换会话", apply: "恢复文件", cursor: "提交历史", commit: "完成持久化",
	compensate: "恢复操作前状态", unlock: "释放工作区锁", discover_gitlinks: "检查子模块", scan_directories: "扫描目录",
	"settled.capture": "结算快照", "settled.workspaceLock": "等待工作区锁",
	"settled.captureBaseline": "捕获结算基线", "settled.rootDiscovery": "扫描工作区根目录",
	"settled.baselineValidation": "校验快照基线", "settled.fullCapture": "完整捕获快照",
	"settled.changedPaths": "比较变更路径", "settled.checkpoint": "记录检查点",
};

function settlementWorkload(
	settlement: OperationResult["settlement"],
	includeCheckpointFiles: boolean,
): string {
	if (settlement === undefined) return "";
	const details: string[] = [];
	if (includeCheckpointFiles && settlement.changedFiles !== undefined) {
		details.push(`changed:${settlement.changedFiles}`);
	}
	const captures = settlement.captures ?? [];
	if (captures.length > 0) {
		const inspected = captures.reduce((total, capture) => Math.min(Number.MAX_SAFE_INTEGER, total + capture.visibleFilesInspected), 0);
		const hashFiles = captures.reduce((total, capture) => Math.min(Number.MAX_SAFE_INTEGER, total + capture.hashFilesPlanned), 0);
		const cacheHits = captures.reduce((total, capture) => Math.min(Number.MAX_SAFE_INTEGER, total + capture.cacheHits), 0);
		details.push(`scan:${inspected} hit:${cacheHits} hash:${hashFiles}`);
	}
	return details.length === 0 ? "" : ` ${details.join(" ")}`;
}

function formatTiming(totalMs: number, timings: OperationResult["timings"], prefix = "total"): string {
	const hasSettlementBreakdown = timings?.some((timing) => timing.phase.startsWith("settled.")) ?? false;
	const hasNestedCaptureTimings = timings?.some((timing) =>
		timing.phase === "settled.rootDiscovery" || timing.phase === "settled.baselineValidation" ||
		timing.phase === "settled.fullCapture") ?? false;
	const phases = [...(timings ?? [])]
		.filter((timing) => timing.durationMs >= 5 &&
			!(hasSettlementBreakdown && timing.phase === "checkpoint") &&
			!(hasNestedCaptureTimings && (timing.phase === "settled.capture" || timing.phase === "settled.captureBaseline")))
		.sort((left, right) => right.durationMs - left.durationMs)
		.slice(0, 5)
		.map((timing) => `${timing.phase}:${timing.durationMs}ms`)
		.join(" ");
	return ` ${prefix}:${Math.round(totalMs)}ms${phases.length === 0 ? "" : ` ${phases}`}`;
}

function sanitize(value: string): string {
	return value
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,})/gi, "<redacted>")
		.replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, "<path>")
		.replace(/[\u0000-\u001F\u007F]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
}
