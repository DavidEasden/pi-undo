import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type { SettledChangeProbe } from "./controller.ts";
import type { SnapshotManifest } from "./model.ts";
import { checkOperation } from "./operation-context.ts";
import { relativeSafePath } from "./path-safety.ts";
import type { RootTopology } from "./root-discovery.ts";
import type { SnapshotStore } from "./snapshot-store.ts";

const MAX_PATHS = 2_048;

/** 这些路径能改变仓库边界或 scope 外的可见性，不能仅捕获事件自身。 */
export function changesNeedFullCapture(paths: readonly string[]): boolean {
	return paths.some((path) => path === "." || path.split("/").some((part) =>
		[".git", ".gitignore", ".gitmodules", ".gitattributes"].includes(part.toLowerCase())));
}

const atOrBelow = (scope: string, path: string) => path === scope || path.startsWith(`${scope}/`);

/** 恢复计划按精确路径匹配，目录需同时展开旧树和当前树，且包括必要的目录项。 */
export async function prepareSettlementScope(
	store: SnapshotStore, topology: RootTopology, before: SnapshotManifest, probe: SettledChangeProbe,
): Promise<readonly string[] | undefined> {
	const candidates = [...new Set([...probe.files, ...probe.directories])].sort();
	if (!probe.trusted || before.coverage !== "complete" || before.topologyFingerprint !== topology.fingerprint ||
		candidates.length === 0 || candidates.length > MAX_PATHS || changesNeedFullCapture(candidates)) return undefined;
	for (const path of candidates) relativeSafePath(topology.workspaceIdentity, path);
	const directories = probe.directories.filter((path, index, all) =>
		all.indexOf(path) === index && !all.some((parent) => parent !== path && atOrBelow(parent, path)));
	if (topology.roots.some((root) => root.state !== "active" || root.gitlinkOid !== undefined ||
		(root.relativeRoot !== "." && directories.some((path) => atOrBelow(path, root.relativeRoot))))) return undefined;
	const paths = new Set(candidates);
	if (directories.length > 0) {
		for (const root of before.roots) {
			const relativeScopes = directories.flatMap((path) => root.relativeRoot === "." ? [path]
				: atOrBelow(root.relativeRoot, path) ? [path.slice(root.relativeRoot.length + 1)] : []);
			if (relativeScopes.length === 0) continue;
			for (const entry of await store.listTree(before.manifestId, root.relativeRoot, relativeScopes)) {
				const path = root.relativeRoot === "." ? entry.relativePath : `${root.relativeRoot}/${entry.relativePath}`;
				if (!directories.some((directory) => atOrBelow(directory, path))) continue;
				if (entry.kind === "symlink") return undefined;
				paths.add(path);
				if (paths.size > MAX_PATHS) return undefined;
			}
		}
		const visible = await store.listVisibleLeafPaths(topology, {
			includePaths: directories, topologyAlreadyValidated: true,
		});
		for (const leaf of visible) {
			let path = leaf;
			while (directories.some((directory) => atOrBelow(directory, path))) {
				paths.add(path);
				if (paths.size > MAX_PATHS) return undefined;
				const separator = path.lastIndexOf("/");
				if (separator < 0) break;
				path = path.slice(0, separator);
			}
		}
	}
	if (changesNeedFullCapture([...paths])) return undefined;
	for (const path of paths) {
		checkOperation();
		const metadata = await lstat(join(topology.workspaceIdentity, path)).catch((error) => {
			if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
			throw error;
		});
		if (metadata !== undefined && !metadata.isFile() && !metadata.isDirectory()) return undefined;
	}
	return [...paths].sort();
}
