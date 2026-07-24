import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piUndoExtension(pi: ExtensionAPI): void {
	pi.registerCommand("undo", {
		description: "Undo the last completed Agent run",
		handler: async () => {},
	});
	pi.registerCommand("redo", {
		description: "Redo the last undone Agent run",
		handler: async () => {},
	});
}
