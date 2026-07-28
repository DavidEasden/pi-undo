import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type PathSafetyErrorCode = "unsafe_path" | "symlink_escape";

export class PathSafetyError extends Error {
	readonly code: PathSafetyErrorCode;

	constructor(code: PathSafetyErrorCode, message: string) {
		super(message);
		this.name = "PathSafetyError";
		this.code = code;
	}
}

export function relativeSafePath(root: string, candidate: string): string {
	if (typeof root !== "string" || root.length === 0 || root.includes("\0")) {
		fail("unsafe_path", "root 路径无效");
	}
	assertRelativeCandidate(candidate);
	if (candidate === ".") {
		return candidate;
	}

	const canonicalRoot = resolve(root);
	const absoluteCandidate = resolve(canonicalRoot, candidate);
	const canonicalRelative = relative(canonicalRoot, absoluteCandidate);
	if (
		canonicalRelative === ".." ||
		canonicalRelative.startsWith(`..${sep}`) ||
		isAbsolute(canonicalRelative)
	) {
		fail("unsafe_path", "candidate 不在 root 内或不是规范路径");
	}
	return candidate;
}

export async function assertNoSymlinkEscape(root: string, relativePath: string): Promise<void> {
	const safePath = relativeSafePath(root, relativePath);
	if (safePath === ".") {
		return;
	}

	let current = resolve(root);
	const parts = safePath.split("/");
	for (let index = 0; index < parts.length; index += 1) {
		current = join(current, parts[index]);
		try {
			const metadata = await lstat(current);
			if (index < parts.length - 1) {
				if (metadata.isSymbolicLink()) {
					fail("symlink_escape", "中间路径组件不能是 symlink");
				}
				if (!metadata.isDirectory()) {
					fail("unsafe_path", "中间路径组件不是目录");
				}
			}
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) {
				return;
			}
			throw error;
		}
	}
}

export function pathSetsOverlap(leftPaths: readonly string[], rightPaths: readonly string[]): boolean {
	for (const path of leftPaths) assertRelativeCandidate(path);
	for (const path of rightPaths) assertRelativeCandidate(path);
	const rightSet = new Set(rightPaths);
	const sortedRight = [...rightSet].sort(comparePaths);
	for (const path of leftPaths) {
		if (rightSet.has(path)) return true;
		for (let separator = path.lastIndexOf("/"); separator >= 0; separator = path.lastIndexOf("/", separator - 1)) {
			if (rightSet.has(path.slice(0, separator))) return true;
		}
		const descendantPrefix = `${path}/`;
		const candidate = sortedRight[lowerBound(sortedRight, descendantPrefix)];
		if (candidate?.startsWith(descendantPrefix)) return true;
	}
	return false;
}

export function sortDeletePaths(paths: readonly string[]): string[] {
	return sortPaths(paths, -1);
}

export function sortWritePaths(paths: readonly string[]): string[] {
	return sortPaths(paths, 1);
}

function sortPaths(paths: readonly string[], direction: -1 | 1): string[] {
	for (const path of paths) {
		assertRelativeCandidate(path);
	}
	return [...paths].sort((left, right) => {
		const depthDifference = pathDepth(left) - pathDepth(right);
		if (depthDifference !== 0) {
			return depthDifference * direction;
		}
		return comparePaths(left, right);
	});
}

function assertRelativeCandidate(candidate: string): void {
	if (
		typeof candidate !== "string" ||
		candidate.length === 0 ||
		candidate.includes("\0") ||
		candidate.includes("\\") ||
		isAbsolute(candidate) ||
		/^[A-Za-z]:/.test(candidate)
	) {
		fail("unsafe_path", "candidate 必须是相对 POSIX 路径");
	}
	if (candidate === ".") {
		return;
	}
	if (candidate.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
		fail("unsafe_path", "candidate 包含不安全路径组件");
	}
}

function pathDepth(path: string): number {
	return path === "." ? 0 : path.split("/").length;
}

function lowerBound(paths: readonly string[], target: string): number {
	let low = 0;
	let high = paths.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		if (comparePaths(paths[middle]!, target) < 0) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
}

function comparePaths(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function fail(code: PathSafetyErrorCode, message: string): never {
	throw new PathSafetyError(code, message);
}
