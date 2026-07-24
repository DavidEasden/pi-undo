import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalJson, checksum } from "./encoding.ts";
import { GitRunner } from "./git-runner.ts";
import type { SnapshotRoot } from "./model.ts";

interface RepositoryInfo {
	readonly absoluteRoot: string;
	readonly commonGitDir: string;
	readonly sourceIdentity: string;
	readonly treeId: string | null;
}

interface DiscoveredRoot {
	readonly absoluteRoot: string;
	readonly relativeRoot: string;
	readonly gitBacked: boolean;
	readonly state: SnapshotRoot["state"];
	readonly sourceIdentity: string;
	readonly privateRepositoryId: string;
	readonly treeId: string | null;
	readonly gitlinkOid?: string;
}

export interface RootTopology {
	readonly workspaceIdentity: string;
	readonly roots: readonly SnapshotRoot[];
	readonly fingerprint: string;
}

export type RootDiscoveryErrorCode = "workspace_not_found" | "discovery_failed";

export class RootDiscoveryError extends Error {
	readonly code: RootDiscoveryErrorCode;

	constructor(code: RootDiscoveryErrorCode, message: string) {
		super(message);
		this.name = "RootDiscoveryError";
		this.code = code;
	}
}

export interface RootDiscovery {
	discover(workspaceRoot: string): Promise<RootTopology>;
}

export class RootDiscovery {
	private readonly git: GitRunner;

	constructor(git = new GitRunner()) {
		this.git = git;
	}

	async discover(workspaceRoot: string): Promise<RootTopology> {
		const workspaceIdentity = await canonicalWorkspaceRoot(workspaceRoot);
		const activeRoots = new Map<string, DiscoveredRoot>();
		const outerRepository = await this.inspectRepository(workspaceIdentity, workspaceIdentity);
		if (outerRepository) {
			activeRoots.set(outerRepository.absoluteRoot, this.activeRoot(workspaceIdentity, outerRepository));
		} else {
			activeRoots.set(workspaceIdentity, syntheticRoot(workspaceIdentity));
		}

		await this.scanDirectory(workspaceIdentity, workspaceIdentity, activeRoots);
		const gitlinkRoots = await this.discoverGitlinks(workspaceIdentity, activeRoots);
		const roots = buildRoots([...activeRoots.values(), ...gitlinkRoots.values()]);
		return {
			workspaceIdentity,
			roots,
			fingerprint: topologyFingerprint(workspaceIdentity, roots),
		};
	}

	private async scanDirectory(
		workspaceIdentity: string,
		directory: string,
		activeRoots: Map<string, DiscoveredRoot>,
	): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name === ".git" || entry.isSymbolicLink() || !entry.isDirectory()) {
				continue;
			}
			const candidate = join(directory, entry.name);
			const repository = await this.inspectRepository(candidate, workspaceIdentity);
			if (repository) {
				activeRoots.set(repository.absoluteRoot, this.activeRoot(workspaceIdentity, repository));
			}
			await this.scanDirectory(workspaceIdentity, candidate, activeRoots);
		}
	}

	private async inspectRepository(candidate: string, workspaceIdentity: string): Promise<RepositoryInfo | null> {
		if (!await hasSafeGitMarker(candidate)) {
			return null;
		}

		let absoluteRoot: string;
		try {
			absoluteRoot = await realpath(candidate);
		} catch {
			return null;
		}
		if (!isWithin(workspaceIdentity, absoluteRoot)) {
			return null;
		}

		const details = await this.gitOutput([
			"-C",
			absoluteRoot,
			"rev-parse",
			"--show-toplevel",
			"--git-dir",
			"--git-common-dir",
		]);
		if (details === null) {
			return null;
		}
		const lines = details.trimEnd().split("\n");
		if (lines.length < 3) {
			return null;
		}
		try {
			if ((await realpath(lines[0])) !== absoluteRoot) {
				return null;
			}
		} catch {
			return null;
		}

		const commonGitDir = resolve(absoluteRoot, lines[2]);
		const remote = await this.gitOutput(["-C", absoluteRoot, "config", "--get", "remote.origin.url"]);
		const head = await this.gitOutput(["-C", absoluteRoot, "rev-parse", "HEAD"]);
		return {
			absoluteRoot,
			commonGitDir,
			sourceIdentity: remote?.trim() || `git:${commonGitDir}`,
			treeId: head?.trim() || null,
		};
	}

	private activeRoot(workspaceIdentity: string, repository: RepositoryInfo): DiscoveredRoot {
		return {
			absoluteRoot: repository.absoluteRoot,
			relativeRoot: workspaceRelativePath(workspaceIdentity, repository.absoluteRoot),
			gitBacked: true,
			state: "active",
			sourceIdentity: repository.sourceIdentity,
			privateRepositoryId: checksum(repository.sourceIdentity),
			treeId: repository.treeId,
		};
	}

	private async discoverGitlinks(
		workspaceIdentity: string,
		activeRoots: ReadonlyMap<string, DiscoveredRoot>,
	): Promise<Map<string, DiscoveredRoot>> {
		const result = new Map<string, DiscoveredRoot>();
		for (const root of activeRoots.values()) {
			if (!root.gitBacked || root.state !== "active") {
				continue;
			}
			const stage = await this.gitOutput(["-C", root.absoluteRoot, "ls-files", "--stage", "-z"]);
			if (stage === null) {
				throw new RootDiscoveryError("discovery_failed", "无法读取 Git index");
			}
			for (const gitlink of parseGitlinks(stage)) {
				const absolutePath = resolve(root.absoluteRoot, gitlink.relativePath);
				if (!isWithin(workspaceIdentity, absolutePath)) {
					continue;
				}
				const relativeRoot = workspaceRelativePath(workspaceIdentity, absolutePath);
				if ([...activeRoots.values()].some((candidate) => candidate.relativeRoot === relativeRoot)) {
					continue;
				}
				const state = await gitlinkState(absolutePath);
				const sourceIdentity = `${root.sourceIdentity}:${relativeRoot}`;
				result.set(relativeRoot, {
					absoluteRoot: absolutePath,
					relativeRoot,
					gitBacked: true,
					state,
					sourceIdentity,
					privateRepositoryId: checksum(sourceIdentity),
					treeId: null,
					gitlinkOid: gitlink.oid,
				});
			}
		}
		return result;
	}

	private async gitOutput(args: readonly string[]): Promise<string | null> {
		try {
			const result = await this.git.run(args);
			return result.killed ? null : result.stdout;
		} catch {
			return null;
		}
	}
}

function syntheticRoot(workspaceIdentity: string): DiscoveredRoot {
	return {
		absoluteRoot: workspaceIdentity,
		relativeRoot: ".",
		gitBacked: false,
		state: "active",
		sourceIdentity: workspaceIdentity,
		privateRepositoryId: checksum(workspaceIdentity),
		treeId: null,
	};
}

function buildRoots(discovered: readonly DiscoveredRoot[]): SnapshotRoot[] {
	const unique = new Map<string, DiscoveredRoot>();
	for (const root of discovered) {
		unique.set(root.relativeRoot, root);
	}
	const paths = [...unique.keys()].sort(comparePaths);
	return paths.map((relativeRoot) => {
		const root = unique.get(relativeRoot) as DiscoveredRoot;
		const parentRoot = paths
			.filter((candidate) => isStrictAncestor(candidate, relativeRoot))
			.sort((left, right) => right.length - left.length || comparePaths(left, right))[0] ?? null;
		return {
			relativeRoot,
			parentRoot,
			state: root.state,
			sourceIdentity: root.sourceIdentity,
			privateRepositoryId: root.privateRepositoryId,
			treeId: root.treeId,
			...(root.gitlinkOid === undefined ? {} : { gitlinkOid: root.gitlinkOid }),
		};
	});
}

function topologyFingerprint(workspaceIdentity: string, roots: readonly SnapshotRoot[]): string {
	return checksum(canonicalJson({
		workspaceIdentity,
		roots: roots.map((root) => ({
			relativeRoot: root.relativeRoot,
			parentRoot: root.parentRoot,
			state: root.state,
			sourceIdentity: root.sourceIdentity,
			privateRepositoryId: root.privateRepositoryId,
			gitlinkOid: root.gitlinkOid ?? null,
		})),
	}));
}

async function canonicalWorkspaceRoot(workspaceRoot: string): Promise<string> {
	try {
		return await realpath(workspaceRoot);
	} catch {
		throw new RootDiscoveryError("workspace_not_found", "workspace 根目录不存在");
	}
}

async function hasSafeGitMarker(candidate: string): Promise<boolean> {
	try {
		const marker = await lstat(join(candidate, ".git"));
		return !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile());
	} catch {
		return false;
	}
}

async function gitlinkState(absolutePath: string): Promise<SnapshotRoot["state"]> {
	try {
		const metadata = await lstat(absolutePath);
		return metadata.isDirectory() && !metadata.isSymbolicLink() ? "broken" : "broken";
	} catch {
		return "uninitialized";
	}
}

function parseGitlinks(stage: string): Array<{ oid: string; relativePath: string }> {
	const gitlinks: Array<{ oid: string; relativePath: string }> = [];
	for (const entry of stage.split("\0")) {
		if (entry.length === 0) {
			continue;
		}
		const separator = entry.indexOf("\t");
		if (separator < 0) {
			continue;
		}
		const metadata = entry.slice(0, separator).split(" ");
		if (metadata[0] !== "160000" || metadata.length < 2) {
			continue;
		}
		gitlinks.push({ oid: metadata[1], relativePath: entry.slice(separator + 1) });
	}
	return gitlinks;
}

function workspaceRelativePath(workspaceIdentity: string, absolutePath: string): string {
	const value = relative(workspaceIdentity, absolutePath);
	return value.length === 0 ? "." : value.split(sep).join("/");
}

function isWithin(parent: string, candidate: string): boolean {
	const value = relative(parent, candidate);
	return value.length === 0 || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function isStrictAncestor(parent: string, child: string): boolean {
	return parent === "." ? child !== "." : child.startsWith(`${parent}/`);
}

function comparePaths(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
