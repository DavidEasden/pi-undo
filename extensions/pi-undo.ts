import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
	SessionBeforeTreeEvent as PiSessionBeforeTreeEvent,
	SessionTreeEvent as PiSessionTreeEvent,
} from "@earendil-works/pi-coding-agent";

import type { UndoController } from "../src/controller.ts";
import { createPiUndoRuntime } from "../src/pi-runtime.ts";
import { StatusReporter } from "../src/status-reporter.ts";

export interface PiUndoRuntime {
	readonly controller: UndoController;
	readonly reporter: StatusReporter;
	readonly recovery?: { readonly files?: number; readonly opId?: string };
	setCommandContext?(context: ExtensionCommandContext | undefined): void;
	isInternalNavigation?(): boolean;
}

export type PiUndoRuntimeFactory = (
	context: ExtensionContext,
	pi: ExtensionAPI,
) => Promise<PiUndoRuntime>;

export function createPiUndoExtension(runtimeFactory: PiUndoRuntimeFactory): (pi: ExtensionAPI) => void {
	return (pi) => {
		let runtime: PiUndoRuntime | undefined;
		let generation = 0;

		const initialize = async (context: ExtensionContext): Promise<void> => {
			const currentGeneration = ++generation;
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
			active.reporter.setPhase(action === "undo" ? "undoing" : "redoing");
			active.setCommandContext?.(context);
			let result;
			try {
				result = action === "undo"
					? await active.controller.undo()
					: await active.controller.redo();
			} finally {
				active.setCommandContext?.(undefined);
			}
			if (commandGeneration !== generation || runtime !== active) return;
			active.reporter.result(result);
			if (action === "undo" && result.code === "ok" && result.refillPrompt !== undefined) {
				active.reporter.refillPrompt(result.refillPrompt);
			}
			const history = active.controller.history();
			if (history.locked) active.reporter.setRecoveryRequired(result.message ?? result.code);
			else active.reporter.setReady(history.undoCount, history.redoCount);
		};

		pi.registerCommand("undo", {
			description: "Undo the last completed Agent run",
			handler: async (_args: string, context: ExtensionCommandContext) => runCommand("undo", context),
		});
		pi.registerCommand("redo", {
			description: "Redo the last undone Agent run",
			handler: async (_args: string, context: ExtensionCommandContext) => runCommand("redo", context),
		});

		pi.on("session_start", async (_event: unknown, context: ExtensionContext) => initialize(context));
		pi.on("input", async (event: InputEvent) => {
			if (runtime === undefined) return { action: "handled" as const };
			return runtime.controller.prepareInput(event.text, { streaming: event.streamingBehavior !== undefined });
		});
		pi.on("before_agent_start", async () => { await runtime?.controller.beforeAgentStart(); });
		pi.on("agent_settled", async () => {
			const active = runtime;
			if (active === undefined) return;
			await active.controller.agentSettled();
			if (runtime !== active) return;
			const history = active.controller.history();
			if (history.locked) active.reporter.setRecoveryRequired("session state ambiguous");
			else active.reporter.setReady(history.undoCount, history.redoCount);
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
			await runtime?.controller.cancelTree?.();
			runtime?.reporter.clear();
			runtime = undefined;
		});
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default createPiUndoExtension(createPiUndoRuntime);
