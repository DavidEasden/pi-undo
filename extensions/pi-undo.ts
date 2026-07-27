import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
	SessionBeforeTreeEvent as PiSessionBeforeTreeEvent,
	SessionTreeEvent as PiSessionTreeEvent,
} from "@earendil-works/pi-coding-agent";

import type { UndoController } from "../src/controller.ts";
import { browseDiff } from "../src/diff-ui.ts";
import { computeCheckpointDiff, type DiffSource, formatDiffSummary, sanitizeDisplayText } from "../src/diff-view.ts";
import { createPiUndoRuntime } from "../src/pi-runtime.ts";
import { StatusReporter } from "../src/status-reporter.ts";

export interface PiUndoRuntime {
	readonly controller: UndoController;
	readonly reporter: StatusReporter;
	readonly diffSource?: DiffSource;
	readonly recovery?: { readonly files?: number; readonly opId?: string };
	setCommandContext?(context: ExtensionCommandContext | undefined): void;
	isInternalNavigation?(): boolean;
}

export type PiUndoRuntimeFactory = (
	context: ExtensionContext,
	pi: ExtensionAPI,
) => Promise<PiUndoRuntime>;

type DeferredImage = NonNullable<InputEvent["images"]>[number];

interface DeferredPrompt {
	readonly text: string;
	readonly images?: readonly DeferredImage[];
}

export function createPiUndoExtension(runtimeFactory: PiUndoRuntimeFactory): (pi: ExtensionAPI) => void {
	return (pi) => {
		let runtime: PiUndoRuntime | undefined;
		let runtimeContext: ExtensionContext | undefined;
		let generation = 0;
		let deferredPrompts: DeferredPrompt[] = [];
		let replaying: DeferredPrompt | undefined;
		let acceptedReplay: DeferredPrompt | undefined;
		let activeCommands = new Set<symbol>();
		let activeAction: "undo" | "redo" | undefined;

		const initialize = async (context: ExtensionContext): Promise<void> => {
			const currentGeneration = ++generation;
			runtimeContext = context;
			deferredPrompts = [];
			replaying = undefined;
			acceptedReplay = undefined;
			activeCommands = new Set<symbol>();
			activeAction = undefined;
			try {
				const next = await runtimeFactory(context, pi);
				if (currentGeneration !== generation) return;
				runtime = next;
				await next.controller.recover();
				const history = next.controller.history();
				if (history.locked) next.reporter.setRecoveryRequired("pending journal", next.recovery);
				else next.reporter.setReady(history.undoCount, history.redoCount);
			} catch (error) {
				if (currentGeneration !== generation) return;
				runtime = undefined;
				new StatusReporter(context).setRecoveryRequired(errorMessage(error));
			}
		};

		const dispatchDeferredPrompt = (active: PiUndoRuntime, expectedGeneration: number): void => {
			if (
				expectedGeneration !== generation || runtime !== active || activeCommands.size > 0 ||
				replaying !== undefined || deferredPrompts.length === 0 || active.controller.history().locked
			) return;
			const prompt = deferredPrompts[0]!;
			replaying = prompt;
			acceptedReplay = undefined;
			queueMicrotask(() => {
				if (expectedGeneration !== generation || runtime !== active || replaying !== prompt) return;
				try {
					pi.sendUserMessage(prompt.images === undefined || prompt.images.length === 0
						? prompt.text
						: [{ type: "text" as const, text: prompt.text }, ...prompt.images]);
				} catch (error) {
					replaying = undefined;
					acceptedReplay = undefined;
					deferredPrompts.shift();
					restoreEditorText(runtimeContext, prompt.text);
					runtimeContext?.ui.notify(`Unable to replay queued prompt: ${errorMessage(error)}`, "warning");
				}
			});
		};

		const restoreDeferredPrompts = (context: ExtensionContext | undefined): void => {
			if (deferredPrompts.length === 0) return;
			const prompts = deferredPrompts.splice(0);
			replaying = undefined;
			acceptedReplay = undefined;
			restoreEditorText(context, prompts.map((prompt) => prompt.text).join("\n\n"));
			if (prompts.some((prompt) => (prompt.images?.length ?? 0) > 0)) {
				context?.ui.notify("Queued prompt text restored; image attachments must be reattached", "warning");
			}
		};

		const resumeDeferredPrompts = (
			active: PiUndoRuntime,
			expectedGeneration: number,
			lockedReason: string,
		): void => {
			if (expectedGeneration !== generation || runtime !== active) return;
			const history = active.controller.history();
			if (history.locked) {
				active.reporter.setRecoveryRequired(lockedReason);
				restoreDeferredPrompts(runtimeContext);
			} else {
				active.reporter.setReady(history.undoCount, history.redoCount);
				dispatchDeferredPrompt(active, expectedGeneration);
			}
		};

		const runCommand = async (
			action: "undo" | "redo",
			context: ExtensionCommandContext,
		): Promise<void> => {
			const active = runtime;
			const commandGeneration = generation;
			if (active === undefined) {
				context.ui.notify("pi-undo session unavailable", "warning");
				return;
			}
			const commandToken = Symbol(action);
			const commandSet = activeCommands;
			commandSet.add(commandToken);
			activeAction = action;
			active.reporter.setPhase(action === "undo" ? "undoing" : "redoing");
			active.setCommandContext?.(context);
			let result;
			try {
				result = action === "undo"
					? await active.controller.undo()
					: await active.controller.redo();
			} finally {
				active.setCommandContext?.(undefined);
				commandSet.delete(commandToken);
				if (commandSet === activeCommands && commandSet.size === 0) activeAction = undefined;
			}
			if (commandGeneration !== generation || runtime !== active) return;
			active.reporter.result(result);
			const hasDeferredPrompt = deferredPrompts.length > 0 || replaying !== undefined;
			if (
				action === "undo" && result.code === "ok" && result.refillPrompt !== undefined &&
				!hasDeferredPrompt
			) active.reporter.refillPrompt(result.refillPrompt);
			resumeDeferredPrompts(active, commandGeneration, result.message ?? result.code);
		};

		const runDiff = async (args: string, context: ExtensionCommandContext): Promise<void> => {
			const active = runtime;
			if (active === undefined || active.diffSource === undefined) {
				context.ui.notify("pi-undo session unavailable", "warning");
				return;
			}
			const checkpoints = active.controller.listCheckpoints();
			if (checkpoints.length === 0) {
				context.ui.notify("No recorded Agent runs to diff", "info");
				return;
			}
			const trimmed = args.trim();
			const position = trimmed === "" ? 1 : Number(trimmed);
			if (!Number.isInteger(position) || position < 1 || position > checkpoints.length) {
				context.ui.notify(`Invalid run number; recorded runs: ${checkpoints.length}`, "warning");
				return;
			}
			// 1 = 最近一次 run（栈顶）。
			const checkpoint = checkpoints[checkpoints.length - position]!;
			let diffs;
			try {
				diffs = await computeCheckpointDiff(active.diffSource, checkpoint);
			} catch (error) {
				context.ui.notify(`Unable to load diff: ${sanitizeDisplayText(errorMessage(error), 120)}`, "error");
				return;
			}
			if (runtime !== active) return;
			if (diffs.length === 0) {
				context.ui.notify("This run changed no files", "info");
				return;
			}
			const label = runLabel(checkpoint.rawPrompt, position);
			if (context.mode !== "tui") {
				context.ui.notify(`${label} — ${formatDiffSummary(diffs)}`, "info");
				return;
			}
			await browseDiff(context, label, diffs);
		};

		pi.registerCommand("undo", {
			description: "Undo the last completed Agent run",
			handler: async (_args: string, context: ExtensionCommandContext) => runCommand("undo", context),
		});
		pi.registerCommand("redo", {
			description: "Redo the last undone Agent run",
			handler: async (_args: string, context: ExtensionCommandContext) => runCommand("redo", context),
		});
		pi.registerCommand("diff", {
			description: "Review files changed by an Agent run (latest, or /diff N)",
			handler: async (args: string, context: ExtensionCommandContext) => runDiff(args, context),
		});

		pi.on("session_start", async (_event: unknown, context: ExtensionContext) => initialize(context));
		pi.on("input", async (event: InputEvent, context: ExtensionContext) => {
			const active = runtime;
			if (active === undefined) return { action: "handled" as const };
			const result = await active.controller.prepareInput(event.text, {
				streaming: event.streamingBehavior !== undefined,
			});
			const replay = replaying;
			if (result.action === "defer") {
				if (replay !== undefined && event.source === "extension" && samePrompt(event.text, event.images, replay)) {
					replaying = undefined;
					acceptedReplay = undefined;
					active.reporter.setPhase(`${activeAction ?? "operation"} queued:${deferredPrompts.length}`);
					return { action: "handled" as const };
				}
				if (event.text.trimStart().startsWith("/")) {
					restoreEditorText(context, event.text);
					context.ui.notify("Command input preserved until undo/redo completes", "info");
					return { action: "handled" as const };
				}
				deferredPrompts.push({
					text: event.text,
					...(event.images === undefined ? {} : { images: event.images.map((image) => ({ ...image })) }),
				});
				active.reporter.setPhase(`${activeAction ?? "operation"} queued:${deferredPrompts.length}`);
				return { action: "handled" as const };
			}
			if (replay !== undefined && event.source === "extension" && samePrompt(event.text, event.images, replay)) {
				if (result.action === "continue") {
					acceptedReplay = replay;
				} else {
					removeDeferredPrompt(deferredPrompts, replay);
					replaying = undefined;
					acceptedReplay = undefined;
					restoreEditorText(context, replay.text);
					if ((replay.images?.length ?? 0) > 0) {
						context.ui.notify("Queued prompt text restored; image attachments must be reattached", "warning");
					}
				}
			}
			return result;
		});
		pi.on("before_agent_start", async () => {
			const active = runtime;
			const startGeneration = generation;
			if (active === undefined) return;
			await active.controller.beforeAgentStart();
			const replay = replaying;
			if (
				runtime === active && generation === startGeneration && replay !== undefined &&
				acceptedReplay === replay
			) {
				removeDeferredPrompt(deferredPrompts, replay);
				replaying = undefined;
				acceptedReplay = undefined;
			}
		});
		pi.on("agent_settled", async () => {
			const active = runtime;
			const settledGeneration = generation;
			if (active === undefined) return;
			await active.controller.agentSettled();
			if (runtime !== active || generation !== settledGeneration) return;
			resumeDeferredPrompts(active, settledGeneration, "session state ambiguous");
		});
		pi.on("session_before_tree", async (event: PiSessionBeforeTreeEvent) => {
			if (runtime === undefined) return { cancel: true };
			if (runtime.isInternalNavigation?.()) return undefined;
			const active = runtime;
			const result = await active.controller.beforeTree({ targetLeafId: event.preparation.targetId });
			if (result === undefined) {
				event.signal?.addEventListener("abort", () => { void active.controller.cancelTree?.(); }, { once: true });
			}
			return result;
		});
		pi.on("session_tree", async (event: PiSessionTreeEvent) => {
			if (runtime?.isInternalNavigation?.()) return;
			await runtime?.controller.afterTree({
				newLeafId: event.newLeafId,
				navigationTargetLeafId: event.summaryEntry?.parentId ?? event.newLeafId,
			});
		});
		pi.on("session_shutdown", async () => {
			generation += 1;
			deferredPrompts = [];
			replaying = undefined;
			acceptedReplay = undefined;
			activeCommands = new Set<symbol>();
			activeAction = undefined;
			runtimeContext = undefined;
			await runtime?.controller.cancelTree?.();
			runtime?.reporter.clear();
			runtime = undefined;
		});
	};
}

function samePrompt(
	text: string,
	images: readonly DeferredImage[] | undefined,
	prompt: DeferredPrompt,
): boolean {
	if (text !== prompt.text || (images?.length ?? 0) !== (prompt.images?.length ?? 0)) return false;
	return (images ?? []).every((image, index) => JSON.stringify(image) === JSON.stringify(prompt.images?.[index]));
}

function removeDeferredPrompt(prompts: DeferredPrompt[], prompt: DeferredPrompt): void {
	const index = prompts.indexOf(prompt);
	if (index >= 0) prompts.splice(index, 1);
}

function restoreEditorText(context: ExtensionContext | undefined, text: string): void {
	if (context === undefined || text.length === 0) return;
	const current = context.ui.getEditorText();
	if (current === text || current.startsWith(`${text}\n\n`)) return;
	context.ui.setEditorText(current.length === 0 ? text : `${text}\n\n${current}`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function runLabel(rawPrompt: string, position: number): string {
	const singleLine = sanitizeDisplayText(rawPrompt, 1_000);
	const preview = singleLine.length > 48 ? `${singleLine.slice(0, 47)}…` : singleLine;
	return preview === "" ? `Run #${position}` : `Run #${position}: ${preview}`;
}

export default createPiUndoExtension(createPiUndoRuntime);
