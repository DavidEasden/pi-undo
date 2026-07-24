import { createHash } from "node:crypto";

import type { CursorState, ManifestId, SnapshotManifest } from "./model.ts";

export type ValidationCode =
	| "unsupported_schema"
	| "invalid_manifest"
	| "invalid_cursor"
	| "invalid_root_path"
	| "noncanonical_roots"
	| "invalid_manifest_id"
	| "invalid_operation_id"
	| "checksum_mismatch";

export class ModelValidationError extends Error {
	readonly code: ValidationCode;

	constructor(code: ValidationCode, message: string) {
		super(message);
		this.name = "ModelValidationError";
		this.code = code;
	}
}

export function canonicalJson(value: unknown): string {
	return encodeJson(value, new Set<object>());
}

export function checksum(value: string | Uint8Array): string {
	const input = typeof value === "string" ? value : Buffer.from(value);
	return createHash("sha256").update(input).digest("hex");
}

export function assertManifest(value: unknown): SnapshotManifest {
	const record = assertRecord(value, "invalid_manifest", "manifest 必须是对象");
	assertSchemaVersion(record, "manifest");
	assertManifestFields(record);

	assertRoots(record.roots);
	const manifestId = assertManifestId(record.manifestId);

	if (manifestId !== checksumWithout(record, "manifestId", "invalid_manifest")) {
		fail("checksum_mismatch", "manifest ID 与内容不匹配");
	}

	return value as SnapshotManifest;
}

export function assertCursor(value: unknown): CursorState {
	const record = assertRecord(value, "invalid_cursor", "cursor 必须是对象");
	assertSchemaVersion(record, "cursor");
	assertCursorFields(record);

	if (record.checksum !== checksumWithout(record, "checksum", "invalid_cursor")) {
		fail("checksum_mismatch", "cursor checksum 与内容不匹配");
	}

	return value as CursorState;
}

export function assertOperationId(value: unknown): string {
	assertNonEmptyString(value, "invalid_operation_id", "opId 缺失");
	if (
		value === "." ||
		value === ".." ||
		value.includes("/") ||
		value.includes("\\") ||
		value.includes("\0")
	) {
		fail("invalid_operation_id", "opId 不能作为不安全路径使用");
	}
	return value;
}

function encodeJson(value: unknown, ancestors: Set<object>): string {
	if (value === null) {
		return "null";
	}

	switch (typeof value) {
		case "boolean":
			return value ? "true" : "false";
		case "string":
			return JSON.stringify(value);
		case "number": {
			if (!Number.isFinite(value)) {
				throw new TypeError("canonicalJson 不接受非有限数字");
			}
			const encoded = JSON.stringify(value);
			if (encoded === undefined) {
				throw new TypeError("canonicalJson 无法编码该数字");
			}
			return encoded;
		}
		case "object":
			break;
		default:
			throw new TypeError("canonicalJson 只接受 JSON 值");
	}

	if (ancestors.has(value)) {
		throw new TypeError("canonicalJson 不接受循环引用");
	}

	if (Array.isArray(value)) {
		ancestors.add(value);
		try {
			if (Object.getOwnPropertySymbols(value).length > 0) {
				throw new TypeError("canonicalJson 不接受 symbol 属性");
			}
			for (const key of Object.getOwnPropertyNames(value)) {
				if (key !== "length" && !isArrayIndex(key, value.length)) {
					throw new TypeError("canonicalJson 不接受数组额外属性");
				}
			}
			const items: string[] = [];
			for (let index = 0; index < value.length; index += 1) {
				if (!Object.prototype.hasOwnProperty.call(value, index)) {
					throw new TypeError("canonicalJson 不接受稀疏数组");
				}
				items.push(encodeJson(value[index], ancestors));
			}
			return `[${items.join(",")}]`;
		} finally {
			ancestors.delete(value);
		}
	}

	if (!isPlainObject(value)) {
		throw new TypeError("canonicalJson 只接受普通对象");
	}

	if (Object.getOwnPropertySymbols(value).length > 0) {
		throw new TypeError("canonicalJson 不接受 symbol 属性");
	}

	ancestors.add(value);
	try {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${encodeJson(value[key], ancestors)}`)
			.join(",")}}`;
	} finally {
		ancestors.delete(value);
	}
}

function assertManifestFields(record: Record<string, unknown>): void {
	assertNonEmptyString(record.workspaceIdentity, "invalid_manifest", "workspaceIdentity 缺失");
	assertNonEmptyString(record.topologyFingerprint, "invalid_manifest", "topologyFingerprint 缺失");
	assertNonEmptyString(record.coverage, "invalid_manifest", "coverage 缺失");
	assertNonEmptyString(record.createdAt, "invalid_manifest", "createdAt 缺失");
}

function assertRoots(value: unknown): void {
	if (!Array.isArray(value) || value.length === 0) {
		fail("invalid_manifest", "roots 必须是非空数组");
	}

	let previousRoot: string | undefined;
	const roots = new Set<string>();
	const rootParents: Array<{ relativeRoot: string; parentRoot: string | null }> = [];
	for (const root of value) {
		const record = assertRecord(root, "invalid_manifest", "root 必须是对象");
		assertCanonicalRoot(record.relativeRoot);
		const relativeRoot = record.relativeRoot;

		if (previousRoot !== undefined && previousRoot >= relativeRoot) {
			fail("noncanonical_roots", "roots 必须按 relativeRoot 严格排序");
		}
		previousRoot = relativeRoot;
		roots.add(relativeRoot);

		let parentRoot: string | null = null;
		if (record.parentRoot !== null) {
			assertCanonicalRoot(record.parentRoot);
			parentRoot = record.parentRoot;
		}
		rootParents.push({ relativeRoot, parentRoot });
		if (record.state !== "active" && record.state !== "uninitialized" && record.state !== "broken") {
			fail("invalid_manifest", "root state 无效");
		}
		assertNonEmptyString(record.sourceIdentity, "invalid_manifest", "sourceIdentity 缺失");
		assertNonEmptyString(record.privateRepositoryId, "invalid_manifest", "privateRepositoryId 缺失");
		if (record.treeId !== null) {
			assertNonEmptyString(record.treeId, "invalid_manifest", "treeId 无效");
		}
		if (record.gitlinkOid !== undefined) {
			assertNonEmptyString(record.gitlinkOid, "invalid_manifest", "gitlinkOid 无效");
		}
	}

	if (roots.size !== value.length) {
		fail("noncanonical_roots", "roots 不能重复");
	}
	const rootPaths = [...roots];
	for (const { relativeRoot, parentRoot } of rootParents) {
		const nearestParent = rootPaths
			.filter((candidate) => isStrictRootAncestor(candidate, relativeRoot))
			.sort((left, right) => right.length - left.length || compareRoots(left, right))[0] ?? null;
		if (parentRoot !== nearestParent) {
			fail("invalid_manifest", "parentRoot 必须是已声明的最近祖先");
		}
	}
}

function assertCursorFields(record: Record<string, unknown>): void {
	assertOperationId(record.opId);
	if (record.action !== "undo" && record.action !== "redo" && record.action !== "tree") {
		fail("invalid_cursor", "action 无效");
	}
	assertNullableString(record.fromLogicalLeaf, "invalid_cursor", "fromLogicalLeaf 无效");
	assertNullableString(record.toLogicalLeaf, "invalid_cursor", "toLogicalLeaf 无效");
	assertManifestId(record.targetManifestId);
	assertManifestId(record.rollbackManifestId);
	assertNullableString(record.undoHead, "invalid_cursor", "undoHead 无效");
	if (!isDenseStringArray(record.redoStack)) {
		fail("invalid_cursor", "redoStack 无效");
	}
	assertChecksum(record.descriptorChecksum, "invalid_cursor", "descriptorChecksum 无效");
	assertChecksum(record.checksum, "checksum_mismatch", "checksum 无效");
}

function isDenseStringArray(value: unknown): value is string[] {
	if (!Array.isArray(value)) {
		return false;
	}
	for (let index = 0; index < value.length; index += 1) {
		if (!Object.prototype.hasOwnProperty.call(value, index) || typeof value[index] !== "string" || value[index].length === 0) {
			return false;
		}
	}
	return true;
}

function assertSchemaVersion(record: Record<string, unknown>, name: string): void {
	if (record.schemaVersion !== 1) {
		fail("unsupported_schema", `${name} schemaVersion 不受支持`);
	}
}

function assertManifestId(value: unknown): ManifestId {
	assertChecksum(value, "invalid_manifest_id", "manifest ID 无效");
	return value as ManifestId;
}

function assertCanonicalRoot(value: unknown): asserts value is string {
	if (typeof value !== "string" || !isCanonicalRoot(value)) {
		fail("invalid_root_path", "root 路径必须是规范的相对 POSIX 路径");
	}
}

function isCanonicalRoot(value: string): boolean {
	if (value === ".") {
		return true;
	}
	if (
		value.length === 0 ||
		value.startsWith("/") ||
		value.endsWith("/") ||
		value.includes("\\") ||
		value.includes("\0") ||
		/^[A-Za-z]:/.test(value)
	) {
		return false;
	}
	return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isStrictRootAncestor(parentRoot: string, relativeRoot: string): boolean {
	return parentRoot === "." ? relativeRoot !== "." : relativeRoot.startsWith(`${parentRoot}/`);
}

function isArrayIndex(key: string, length: number): boolean {
	const index = Number(key);
	return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function compareRoots(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function assertRecord(value: unknown, code: ValidationCode, message: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(code, message);
	}
	if (!isPlainObject(value)) {
		fail(code, message);
	}
	return value;
}

function assertNonEmptyString(value: unknown, code: ValidationCode, message: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		fail(code, message);
	}
}

function assertNullableString(value: unknown, code: ValidationCode, message: string): void {
	if (value !== null && (typeof value !== "string" || value.length === 0)) {
		fail(code, message);
	}
}

function assertChecksum(value: unknown, code: ValidationCode, message: string): asserts value is string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
		fail(code, message);
	}
}

function checksumWithout(
	record: Record<string, unknown>,
	key: "manifestId" | "checksum",
	code: ValidationCode,
): string {
	const { [key]: _ignored, ...content } = record;
	try {
		return checksum(canonicalJson(content));
	} catch {
		fail(code, "记录包含无法编码的值");
	}
}

function isPlainObject(value: object): value is Record<string, unknown> {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function fail(code: ValidationCode, message: string): never {
	throw new ModelValidationError(code, message);
}
