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

	constructor(context: StatusContext) {
		this.context = context;
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
		if (details?.files !== undefined && details.opId !== undefined) {
			this.setStatus(`recovery_required files:${details.files} op:${sanitize(details.opId)}`);
			return;
		}
		this.setStatus(`recovery required: ${sanitize(reason)}`);
	}

	clear(): void {
		this.context.ui.setStatus("pi-undo", undefined);
	}

	result(result: OperationResult, totalMs?: number): void {
		const details = result.message === undefined ? "" : ` ${sanitize(result.message)}`;
		const timing = totalMs !== undefined && totalMs >= 1_000
			? formatTiming(totalMs, result.timings)
			: "";
		const message = sanitize(`${result.code} files:${result.changedFiles}${details}${timing}`);
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

function formatTiming(totalMs: number, timings: OperationResult["timings"]): string {
	const phases = [...(timings ?? [])]
		.filter((timing) => timing.durationMs >= 5)
		.sort((left, right) => right.durationMs - left.durationMs)
		.slice(0, 5)
		.map((timing) => `${timing.phase}:${timing.durationMs}ms`)
		.join(" ");
	return ` total:${Math.round(totalMs)}ms${phases.length === 0 ? "" : ` ${phases}`}`;
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
