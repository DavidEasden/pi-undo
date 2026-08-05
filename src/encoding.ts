import { createHash } from "node:crypto";

import type {
	CursorState,
	JournalState,
	ManifestId,
	MutationRecord,
	OperationDescriptor,
	RootTopologyIdentity,
	SnapshotManifest,
	SnapshotRoot,
	TopologyFingerprint,
} from "./model.ts";

export type ValidationCode =
	| "unsupported_schema"
	| "invalid_manifest"
	| "invalid_cursor"
	| "invalid_descriptor"
	| "invalid_journal_state"
	| "invalid_mutation_record"
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

export function sameWorkspaceSnapshot(left: SnapshotManifest, right: SnapshotManifest): boolean {
	if (
		left.schemaVersion !== right.schemaVersion ||
		left.workspaceIdentity !== right.workspaceIdentity ||
		left.topologyFingerprint !== right.topologyFingerprint ||
		left.coverage !== right.coverage ||
		left.roots.length !== right.roots.length
	) return false;
	return left.roots.every((root, index) => {
		const candidate = right.roots[index];
		return candidate !== undefined &&
			root.relativeRoot === candidate.relativeRoot &&
			root.parentRoot === candidate.parentRoot &&
			root.state === candidate.state &&
			root.sourceIdentity === candidate.sourceIdentity &&
			root.privateRepositoryId === candidate.privateRepositoryId &&
			(root.gitlinkOid ?? null) === (candidate.gitlinkOid ?? null) &&
			root.treeId === candidate.treeId &&
			root.coverage === candidate.coverage &&
			root.ignorePolicy === candidate.ignorePolicy &&
			root.ignoreClosure === candidate.ignoreClosure &&
			root.objectClosure === candidate.objectClosure &&
			sameStrings(root.ignoredPresentPaths, candidate.ignoredPresentPaths);
	});
}

export function ignoredPresentClosure(
	root: Pick<SnapshotRoot, "coverage" | "ignorePolicy" | "ignoredPresentPaths">,
): string {
	return checksum(canonicalJson({
		coverage: root.coverage,
		ignorePolicy: root.ignorePolicy,
		ignoredPresentPaths: root.ignoredPresentPaths,
	}));
}

export function topologyFingerprint(
	workspaceIdentity: string,
	roots: readonly RootTopologyIdentity[],
): TopologyFingerprint {
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
	})) as TopologyFingerprint;
}

export function assertManifest(value: unknown): SnapshotManifest {
	const record = assertRecord(value, "invalid_manifest", "manifest 必须是对象");
	assertSchemaVersion(record, "manifest");
	assertManifestFields(record);

	assertRoots(record.roots);
	if (record.topologyFingerprint !== topologyFingerprint(record.workspaceIdentity, record.roots)) {
		fail("checksum_mismatch", "topology fingerprint 与 manifest roots 不匹配");
	}
	if (record.coverage === "complete" && record.roots.some((root) => root.coverage !== "complete")) {
		fail("invalid_manifest", "全量 manifest 的所有 root coverage 必须是 complete");
	}
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

export function assertOperationDescriptor(value: unknown): OperationDescriptor {
	const record = assertRecord(value, "invalid_descriptor", "operation descriptor 必须是对象");
	assertSchemaVersion(record, "operation descriptor");
	assertOperationId(record.opId);
	assertSessionFileIdentity(record.sessionIdentity, "invalid_descriptor");
	assertNonEmptyString(record.workspaceIdentity, "invalid_descriptor", "workspaceIdentity 无效");
	if (record.action !== "undo" && record.action !== "redo" && record.action !== "tree") {
		fail("invalid_descriptor", "action 无效");
	}
	assertNullableString(record.fromLogicalLeaf, "invalid_descriptor", "fromLogicalLeaf 无效");
	assertNullableString(record.toLogicalLeaf, "invalid_descriptor", "toLogicalLeaf 无效");
	assertManifestId(record.targetManifestId);
	assertManifestId(record.rollbackManifestId);
	assertCoverage(record.coverage, false, "coverage 无效");
	assertScopePaths(record.scopePaths, record.coverage);
	assertChecksum(record.planDigest, "invalid_descriptor", "planDigest 无效");
	assertChecksum(record.checksum, "checksum_mismatch", "checksum 无效");
	if (record.checksum !== checksumWithout(record, "checksum", "invalid_descriptor")) {
		fail("checksum_mismatch", "operation descriptor checksum 不匹配");
	}
	return value as OperationDescriptor;
}

export function assertJournalState(value: unknown): JournalState {
	const record = assertRecord(value, "invalid_journal_state", "journal state 必须是对象");
	assertSchemaVersion(record, "journal state");
	assertOperationId(record.opId);
	if (!isJournalPhase(record.phase)) {
		fail("invalid_journal_state", "journal phase 无效");
	}
	if (typeof record.revision !== "number" || !Number.isInteger(record.revision) || record.revision < 1) {
		fail("invalid_journal_state", "journal revision 无效");
	}
	assertChecksum(record.descriptorChecksum, "invalid_journal_state", "descriptor checksum 无效");
	if (record.observedLogicalLeaf !== undefined) {
		assertNullableString(record.observedLogicalLeaf, "invalid_journal_state", "observedLogicalLeaf 无效");
	}
	assertChecksum(record.checksum, "checksum_mismatch", "checksum 无效");
	if (record.checksum !== checksumWithout(record, "checksum", "invalid_journal_state")) {
		fail("checksum_mismatch", "journal state checksum 不匹配");
	}
	return value as JournalState;
}

export function assertMutationRecord(value: unknown): MutationRecord {
	const record = assertRecord(value, "invalid_mutation_record", "mutation record 必须是对象");
	assertSchemaVersion(record, "mutation record");
	assertOperationId(record.opId);
	if (typeof record.ordinal !== "number" || !Number.isInteger(record.ordinal) || record.ordinal < 1) {
		fail("invalid_mutation_record", "mutation ordinal 无效");
	}
	if (!isMutationState(record.state)) {
		fail("invalid_mutation_record", "mutation state 无效");
	}
	if (record.kind !== "write" && record.kind !== "delete" && record.kind !== "symlink") {
		fail("invalid_mutation_record", "mutation kind 无效");
	}
	if (record.kind === "write" && record.targetArtifact === null) {
		fail("invalid_mutation_record", "write mutation 必须包含 targetArtifact");
	}
	assertWorkspacePath(record.path, "path");
	assertWorkspacePath(record.sourceArtifact, "sourceArtifact");
	if (record.targetArtifact !== null) {
		assertWorkspacePath(record.targetArtifact, "targetArtifact");
	}
	const parent = workspaceParent(record.path);
	if (workspaceParent(record.sourceArtifact) !== parent) {
		fail("invalid_mutation_record", "sourceArtifact 必须与 path 位于同一父目录");
	}
	if (record.targetArtifact !== null && workspaceParent(record.targetArtifact) !== parent) {
		fail("invalid_mutation_record", "targetArtifact 必须与 path 位于同一父目录");
	}
	assertChecksum(record.sourceFingerprint, "invalid_mutation_record", "sourceFingerprint 无效");
	assertChecksum(record.targetFingerprint, "invalid_mutation_record", "targetFingerprint 无效");
	if (record.previousChecksum !== null) {
		assertChecksum(record.previousChecksum, "invalid_mutation_record", "previousChecksum 无效");
	}
	assertChecksum(record.checksum, "checksum_mismatch", "mutation checksum 无效");
	if (record.checksum !== checksumWithout(record, "checksum", "invalid_mutation_record")) {
		fail("checksum_mismatch", "mutation checksum 与内容不匹配");
	}
	return value as MutationRecord;
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

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
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

	if (!hasOnlyEnumerableDataProperties(value)) {
		throw new TypeError("canonicalJson 只接受自身的可枚举数据属性");
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

function assertManifestFields(record: Record<string, unknown>): asserts record is Record<string, unknown> & {
	workspaceIdentity: string;
	topologyFingerprint: string;
	coverage: string;
	createdAt: string;
} {
	assertNonEmptyString(record.workspaceIdentity, "invalid_manifest", "workspaceIdentity 缺失");
	assertChecksum(record.topologyFingerprint, "invalid_manifest", "topologyFingerprint 无效");
	assertCoverage(record.coverage, false, "manifest coverage 无效");
	assertNonEmptyString(record.createdAt, "invalid_manifest", "createdAt 缺失");
}

function assertRoots(value: unknown): asserts value is SnapshotManifest["roots"] {
	if (!Array.isArray(value) || value.length === 0) {
		fail("invalid_manifest", "roots 必须是非空数组");
	}

	let previousRoot: string | undefined;
	const roots = new Set<string>();
	const rootParents: Array<{ relativeRoot: string; parentRoot: string | null }> = [];
	const ignoredPathsByRoot: Array<{ relativeRoot: string; paths: readonly string[] }> = [];
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
		assertChecksum(record.privateRepositoryId, "invalid_manifest", "privateRepositoryId 无效");
		if (record.privateRepositoryId !== checksum(record.sourceIdentity)) {
			fail("invalid_manifest", "privateRepositoryId 与 sourceIdentity 不匹配");
		}
		if (record.treeId !== null) {
			assertNonEmptyString(record.treeId, "invalid_manifest", "treeId 无效");
		}
		if (record.state === "active" ? record.treeId === null : record.treeId !== null) {
			fail("invalid_manifest", "root state 与 treeId 不一致");
		}
		if (record.gitlinkOid !== undefined) {
			assertNonEmptyString(record.gitlinkOid, "invalid_manifest", "gitlinkOid 无效");
		}
		assertCoverage(record.coverage, true, "root coverage 无效");
		assertNonEmptyString(record.ignorePolicy, "invalid_manifest", "root ignorePolicy 缺失");
		assertIgnoredPresentPaths(record.ignoredPresentPaths);
		if ((record.coverage === "none" || record.state !== "active") && record.ignoredPresentPaths.length > 0) {
			fail("invalid_manifest", "inactive 或 coverage 为 none 的 root 不能包含 ignored-present proof");
		}
		assertChecksum(record.ignoreClosure, "invalid_manifest", "root ignoreClosure 无效");
		if (record.ignoreClosure !== ignoredPresentClosure({
			coverage: record.coverage,
			ignorePolicy: record.ignorePolicy,
			ignoredPresentPaths: record.ignoredPresentPaths,
		})) {
			fail("invalid_manifest", "root ignored-present proof closure 不匹配");
		}
		ignoredPathsByRoot.push({ relativeRoot, paths: record.ignoredPresentPaths });
		assertChecksum(record.objectClosure, "invalid_manifest", "root objectClosure 无效");
	}

	if (roots.size !== value.length) {
		fail("noncanonical_roots", "roots 不能重复");
	}
	if (!roots.has(".")) {
		fail("invalid_manifest", "roots 必须包含 workspace 根");
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
	for (const { relativeRoot, paths } of ignoredPathsByRoot) {
		const descendantRoots = rootPaths.filter((candidate) => isStrictRootAncestor(relativeRoot, candidate));
		for (const path of paths) {
			const workspacePath = relativeRoot === "." ? path : `${relativeRoot}/${path}`;
			if (descendantRoots.some(
				(descendantRoot) => workspacePath === descendantRoot ||
					workspacePath.startsWith(`${descendantRoot}/`) ||
					descendantRoot.startsWith(`${workspacePath}/`),
			)) {
				fail("invalid_manifest", "root ignoredPresentPaths 不能与 descendant root 冲突");
			}
		}
	}
}

function assertCoverage(value: unknown, allowNone: boolean, message: string): asserts value is string {
	if (
		value === "complete" ||
		(allowNone && value === "none") ||
		(typeof value === "string" && /^paths:[0-9a-f]{64}$/.test(value))
	) {
		return;
	}
	fail("invalid_manifest", message);
}

function assertIgnoredPresentPaths(value: unknown): asserts value is string[] {
	if (!Array.isArray(value)) {
		fail("invalid_manifest", "root ignoredPresentPaths 必须是数组");
	}
	let previous: string | undefined;
	const paths = new Set<string>();
	for (let index = 0; index < value.length; index += 1) {
		if (!Object.prototype.hasOwnProperty.call(value, index)) {
			fail("invalid_manifest", "root ignoredPresentPaths 必须是稠密数组");
		}
		const path = value[index];
		if (
			typeof path !== "string" ||
			path === "." ||
			!isCanonicalRoot(path) ||
			path.split("/").some((component) => component.toLowerCase() === ".git")
		) {
			fail("invalid_manifest", "root ignoredPresentPaths 包含不安全路径");
		}
		if (previous !== undefined && previous >= path) {
			fail("invalid_manifest", "root ignoredPresentPaths 必须严格排序且不能重复");
		}
		if (path.split("/").slice(0, -1).some(
			(_part, ancestorIndex, parts) => paths.has(parts.slice(0, ancestorIndex + 1).join("/")),
		)) {
			fail("invalid_manifest", "root ignoredPresentPaths 不能包含叶子前缀冲突");
		}
		paths.add(path);
		previous = path;
	}
}

function assertCursorFields(record: Record<string, unknown>): void {
	assertOperationId(record.opId);
	if (record.action !== "undo" && record.action !== "redo" && record.action !== "tree") {
		fail("invalid_cursor", "action 无效");
	}
	assertSessionFileIdentity(record.sessionIdentity, "invalid_cursor");
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

function assertSessionFileIdentity(value: unknown, code: ValidationCode): void {
	const record = assertRecord(value, code, "sessionIdentity 无效");
	if (typeof record.path !== "string" || record.path.length === 0 || record.path.includes("\0")) {
		fail(code, "sessionIdentity path 无效");
	}
	assertChecksum(record.headerChecksum, code, "sessionIdentity headerChecksum 无效");
}

function assertScopePaths(value: unknown, coverage: unknown): void {
	if (!Array.isArray(value)) {
		fail("invalid_descriptor", "scopePaths 必须是数组");
	}
	let previous: string | undefined;
	for (let index = 0; index < value.length; index += 1) {
		const path = value[index];
		if (!Object.prototype.hasOwnProperty.call(value, index) || typeof path !== "string" || !isCanonicalRoot(path)) {
			fail("invalid_descriptor", "scopePaths 包含不安全路径");
		}
		if (previous !== undefined && previous >= path) {
			fail("invalid_descriptor", "scopePaths 必须严格排序且不能重复");
		}
		previous = path;
	}
	if (typeof coverage === "string" && coverage.startsWith("paths:")) {
		const expected = `paths:${checksum(canonicalJson(value))}`;
		if (coverage !== expected) {
			fail("invalid_descriptor", "scopePaths 与 coverage 不匹配");
		}
	}
}

function isJournalPhase(value: unknown): value is JournalState["phase"] {
	return value === "PREPARING" || value === "PREPARED" || value === "SESSION_MOVED" ||
		value === "APPLYING" || value === "FILES_VERIFIED" || value === "CURSOR_COMMITTED" ||
		value === "COMMITTED" || value === "ABORTING" || value === "ABORTED" ||
		value === "RECOVERY_REQUIRED";
}

function isMutationState(value: unknown): value is MutationRecord["state"] {
	return value === "INTENT" || value === "SOURCE_QUARANTINED" || value === "SOURCE_VERIFIED" ||
		value === "TARGET_INSTALLED" || value === "TARGET_VERIFIED" || value === "CLEANED";
}

function assertWorkspacePath(value: unknown, name: string): asserts value is string {
	if (
		typeof value !== "string" ||
		value === "." ||
		!isCanonicalRoot(value) ||
		value.split("/").some((component) => component.toLowerCase() === ".git")
	) {
		fail("invalid_mutation_record", `${name} 必须是安全的 workspace 相对路径`);
	}
}

function workspaceParent(path: string): string {
	const separator = path.lastIndexOf("/");
	return separator === -1 ? "" : path.slice(0, separator);
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
	if (!hasOnlyEnumerableDataProperties(value)) {
		fail(code, message);
	}
	return value;
}

function hasOnlyEnumerableDataProperties(value: object): boolean {
	if (Object.getOwnPropertySymbols(value).length > 0) {
		return false;
	}
	return Object.values(Object.getOwnPropertyDescriptors(value)).every(
		(descriptor) => descriptor.enumerable && Object.hasOwn(descriptor, "value"),
	);
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
