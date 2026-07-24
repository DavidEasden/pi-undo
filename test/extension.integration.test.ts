import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import extension from "../extensions/pi-undo.ts";

describe("pi-undo extension", () => {
	it("注册 undo 和 redo 命令", () => {
		const commandDescriptions = new Map<string, string | undefined>();
		const pi = {
			registerCommand(name: string, options: { description?: string }): void {
				commandDescriptions.set(name, options.description);
			},
		} as unknown as ExtensionAPI;

		extension(pi);

		expect([...commandDescriptions.keys()].sort()).toEqual(["redo", "undo"]);
		expect(commandDescriptions.get("undo")).toContain("last completed Agent run");
	});
});
