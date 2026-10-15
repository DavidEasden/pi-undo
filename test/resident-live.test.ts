import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { NativeDirectoryScanner } from "../src/native-directory-scan.ts";

const binary = join(process.cwd(), "native/pi-undo-fs/target/release/pi-undo-fs");

describe.skipIf(process.platform !== "darwin" || !existsSync(binary))("resident scan smoke", () => {
	it("预热后复用缓存并在目录事件后重扫", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "pi-undo-resident-live-")));
		const scanner = new NativeDirectoryScanner(binary);
		try {
			await mkdir(join(root, "node_modules", "pkg-a", ".git"), { recursive: true });
			scanner.prewarm(root);
			const first = await scanner.scan(root);
			expect(first?.repositories.map((entry) => entry.path)).toContain("node_modules/pkg-a");
			const cached = await scanner.scan(root);
			expect(cached?.repositories.map((entry) => entry.path)).toEqual(first?.repositories.map((entry) => entry.path));
			await mkdir(join(root, "node_modules", "pkg-b", ".git"), { recursive: true });
			await new Promise((resolve) => setTimeout(resolve, 300));
			const changed = await scanner.scan(root);
			expect(changed?.repositories.map((entry) => entry.path)).toContain("node_modules/pkg-b");
		} finally {
			await scanner.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
});
