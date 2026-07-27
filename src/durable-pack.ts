import { randomBytes } from "node:crypto";
import { copyFile, link, lstat, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { fsyncDirectory, fsyncFile } from "./atomic-fs.ts";
import { canonicalJson, checksum } from "./encoding.ts";
import type { MutationJournal } from "./mutation-journal.ts";
import { assertNoSymlinkEscape, relativeSafePath } from "./path-safety.ts";
import { fingerprintAbsent, fingerprintBytes, fingerprintFile, fingerprintSymlink } from "./quarantine.ts";

const PACK_FILE = "durable-pack-v1.bin";
const MAGIC = Buffer.from("PIUNDO-PACK-V1\0", "ascii");
const MAX_HEADER_BYTES = 16 * 1024 * 1024;
const FINALIZE_CONCURRENCY = 32;

export type DurableLeafInput =
	| { readonly kind: "absent"; readonly fingerprint: string }
	| { readonly kind: "file"; readonly fingerprint: string; readonly mode: number; readonly bytes: Uint8Array }
	| { readonly kind: "symlink"; readonly fingerprint: string; readonly linkText: string };

export interface DurablePackEntryInput {
	readonly path: string;
	readonly sourceArtifact: string;
	readonly targetArtifact: string | null;
	readonly sourceFingerprint: string;
	readonly targetFingerprint: string | null;
	readonly variants: readonly DurableLeafInput[];
}

export interface DurablePackInput {
	readonly opId: string;
	readonly planDigest: string;
	readonly entries: readonly DurablePackEntryInput[];
}

interface PackedVariantHeader {
	readonly kind: DurableLeafInput["kind"];
	readonly fingerprint: string;
	readonly mode?: number;
	readonly linkText?: string;
	readonly offset?: number;
	readonly length?: number;
	readonly dataChecksum?: string;
}

interface PackedEntryHeader {
	readonly path: string;
	readonly sourceArtifact: string;
	readonly targetArtifact: string | null;
	readonly sourceFingerprint: string;
	readonly targetFingerprint: string | null;
	readonly variants: readonly PackedVariantHeader[];
}

interface PackHeaderPayload {
	readonly schemaVersion: 1;
	readonly opId: string;
	readonly planDigest: string;
	readonly entries: readonly PackedEntryHeader[];
}

interface PackHeader extends PackHeaderPayload {
	readonly checksum: string;
}

export type DurableLeaf =
	| { readonly kind: "absent"; readonly fingerprint: string }
	| { readonly kind: "file"; readonly fingerprint: string; readonly mode: number; readonly bytes: Uint8Array }
	| { readonly kind: "symlink"; readonly fingerprint: string; readonly linkText: string };

export class DurablePack {
	readonly opId: string;
	readonly planDigest: string;
	readonly storagePath: string;
	readonly packChecksum: string;
	private readonly entries: ReadonlyMap<string, {
		readonly sourceArtifact: string;
		readonly targetArtifact: string | null;
		readonly sourceFingerprint: string;
		readonly targetFingerprint: string | null;
		readonly variants: ReadonlyMap<string, DurableLeaf>;
	}>;

	constructor(
		opId: string,
		planDigest: string,
		storagePath: string,
		packChecksum: string,
		entries: ReadonlyMap<string, {
			readonly sourceArtifact: string;
			readonly targetArtifact: string | null;
			readonly sourceFingerprint: string;
			readonly targetFingerprint: string | null;
			readonly variants: ReadonlyMap<string, DurableLeaf>;
		}>,
	) {
		this.opId = opId;
		this.planDigest = planDigest;
		this.storagePath = storagePath;
		this.packChecksum = packChecksum;
		this.entries = entries;
	}

	paths(): readonly string[] {
		return [...this.entries.keys()];
	}

	artifacts(path: string): { readonly source: string; readonly target: string | null } | undefined {
		const entry = this.entries.get(path);
		return entry === undefined ? undefined : { source: entry.sourceArtifact, target: entry.targetArtifact };
	}

	sourceFingerprint(path: string): string | undefined {
		return this.entries.get(path)?.sourceFingerprint;
	}

	targetFingerprint(path: string): string | null | undefined {
		return this.entries.get(path)?.targetFingerprint;
	}

	leaf(path: string, fingerprint: string): DurableLeaf | undefined {
		const leaf = this.entries.get(path)?.variants.get(fingerprint);
		if (leaf === undefined) return undefined;
		return leaf.kind === "file" ? { ...leaf, bytes: new Uint8Array(leaf.bytes) } : leaf;
	}
}

export function durablePackPath(journal: MutationJournal): string {
	return join(dirname(journal.storagePath), PACK_FILE);
}

export async function createDurablePack(
	journal: MutationJournal,
	input: DurablePackInput,
): Promise<DurablePack> {
	if (input.opId !== journal.operationId) throw new Error("durable pack opId 与 mutation journal 不匹配");
	assertDigest(input.planDigest, "planDigest");
	const entries = canonicalEntries(input.entries);
	const payloads: Buffer[] = [];
	let offset = 0;
	const headerEntries: PackedEntryHeader[] = entries.map((entry) => ({
		path: entry.path,
		sourceArtifact: entry.sourceArtifact,
		targetArtifact: entry.targetArtifact,
		sourceFingerprint: entry.sourceFingerprint,
		targetFingerprint: entry.targetFingerprint,
		variants: entry.variants.map((variant): PackedVariantHeader => {
			if (variant.kind === "absent") return variant;
			if (variant.kind === "symlink") return variant;
			const bytes = Buffer.from(variant.bytes);
			payloads.push(bytes);
			const header = {
				kind: "file" as const,
				fingerprint: variant.fingerprint,
				mode: variant.mode,
				offset,
				length: bytes.length,
				dataChecksum: checksum(bytes),
			};
			offset += bytes.length;
			return header;
		}),
	}));
	const headerPayload: PackHeaderPayload = {
		schemaVersion: 1,
		opId: input.opId,
		planDigest: input.planDigest,
		entries: headerEntries,
	};
	const header: PackHeader = {
		...headerPayload,
		checksum: checksum(canonicalJson(headerPayload)),
	};
	const headerBytes = Buffer.from(canonicalJson(header), "utf8");
	if (headerBytes.length > MAX_HEADER_BYTES) throw new Error("durable pack header 过大");
	const lengthBytes = Buffer.allocUnsafe(4);
	lengthBytes.writeUInt32BE(headerBytes.length);
	const packPath = durablePackPath(journal);
	const temporary = join(dirname(packPath), `.${PACK_FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
	let handle;
	try {
		handle = await open(temporary, "wx", 0o600);
		await writeAll(handle, MAGIC);
		await writeAll(handle, lengthBytes);
		await writeAll(handle, headerBytes);
		for (const payload of payloads) await writeAll(handle, payload);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, packPath);
		await fsyncDirectory(dirname(packPath));
	} catch (error) {
		await handle?.close().catch(() => {});
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
	const packChecksum = checksum(Buffer.concat([MAGIC, lengthBytes, headerBytes, ...payloads]));
	return durablePackFromInput(input.opId, input.planDigest, packPath, packChecksum, entries);
}

export async function loadDurablePack(
	journal: MutationJournal,
	expectedPlanDigest?: string,
	allowForeignOperation = false,
): Promise<DurablePack> {
	const bytes = await readFile(durablePackPath(journal));
	if (bytes.length < MAGIC.length + 4 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
		throw new Error("durable pack magic 无效");
	}
	const headerLength = bytes.readUInt32BE(MAGIC.length);
	if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES) throw new Error("durable pack header 长度无效");
	const headerStart = MAGIC.length + 4;
	const payloadStart = headerStart + headerLength;
	if (payloadStart > bytes.length) throw new Error("durable pack header 被截断");
	const parsed: unknown = JSON.parse(bytes.subarray(headerStart, payloadStart).toString("utf8"));
	const header = assertPackHeader(parsed);
	if (!allowForeignOperation && header.opId !== journal.operationId) throw new Error("durable pack opId 不匹配");
	if (expectedPlanDigest !== undefined && header.planDigest !== expectedPlanDigest) {
		throw new Error("durable pack planDigest 不匹配");
	}
	const result = new Map<string, {
		readonly sourceArtifact: string;
		readonly targetArtifact: string | null;
		readonly sourceFingerprint: string;
		readonly targetFingerprint: string | null;
		readonly variants: ReadonlyMap<string, DurableLeaf>;
	}>();
	for (const entry of header.entries) {
		const variants = new Map<string, DurableLeaf>();
		for (const variant of entry.variants) {
			let leaf: DurableLeaf;
			if (variant.kind === "absent") {
				leaf = { kind: "absent", fingerprint: variant.fingerprint };
			} else if (variant.kind === "symlink") {
				leaf = { kind: "symlink", fingerprint: variant.fingerprint, linkText: variant.linkText! };
			} else {
				const start = payloadStart + variant.offset!;
				const end = start + variant.length!;
				if (start < payloadStart || end > bytes.length) throw new Error("durable pack payload 越界");
				const content = bytes.subarray(start, end);
				if (checksum(content) !== variant.dataChecksum) throw new Error("durable pack payload checksum 不匹配");
				leaf = {
					kind: "file",
					fingerprint: variant.fingerprint,
					mode: variant.mode!,
					bytes: new Uint8Array(content),
				};
			}
			const semanticFingerprint = leaf.kind === "absent"
				? fingerprintAbsent(entry.path)
				: leaf.kind === "file"
					? fingerprintBytes(entry.path, leaf.bytes, leaf.mode)
					: fingerprintSymlink(entry.path, leaf.linkText);
			if (semanticFingerprint !== leaf.fingerprint) {
				throw new Error(`durable pack semantic fingerprint 不匹配：${entry.path}`);
			}
			variants.set(variant.fingerprint, leaf);
		}
		result.set(entry.path, {
			sourceArtifact: entry.sourceArtifact,
			targetArtifact: entry.targetArtifact,
			sourceFingerprint: entry.sourceFingerprint,
			targetFingerprint: entry.targetFingerprint,
			variants,
		});
	}
	return new DurablePack(header.opId, header.planDigest, durablePackPath(journal), checksum(bytes), result);
}

export async function hasDurablePack(journal: MutationJournal): Promise<boolean> {
	try {
		const metadata = await lstat(durablePackPath(journal));
		return metadata.isFile() && !metadata.isSymbolicLink();
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
}

export async function publishCachedDurablePack(
	cachedPath: string,
	journal: MutationJournal,
	expectedPlanDigest: string,
	expectedPackChecksum: string,
): Promise<DurablePack> {
	const target = durablePackPath(journal);
	if (checksum(await readFile(cachedPath)) !== expectedPackChecksum) {
		throw new Error("durable cache pack checksum 不匹配");
	}
	await rm(target, { force: true });
	try {
		await link(cachedPath, target);
		await fsyncDirectory(dirname(target));
	} catch (error) {
		if (!hasErrorCode(error, "EXDEV")) throw error;
		await copyFile(cachedPath, target);
		await fsyncFile(target);
		await fsyncDirectory(dirname(target));
	}
	const pack = await loadDurablePack(journal, expectedPlanDigest, true);
	if (pack.packChecksum !== expectedPackChecksum) throw new Error("durable published pack checksum 不匹配");
	return pack;
}

export async function finalizeDurablePack(
	journal: MutationJournal,
	workspaceRoot: string,
	options: { readonly allowCleanedOwnershipWithoutMarker?: boolean } = {},
): Promise<void> {
	const pack = await loadDurablePack(journal, undefined, true);
	const mutationStates = options.allowCleanedOwnershipWithoutMarker === false
		? undefined
		: new Map((await journal.load()).map((record) => [record.path, record.state]));
	const canonicalRoot = resolve(workspaceRoot);
	const directories = new Set<string>();
	await mapConcurrent(pack.paths(), FINALIZE_CONCURRENCY, async (path) => {
		const targetFingerprint = pack.targetFingerprint(path);
		if (targetFingerprint === undefined || targetFingerprint === null) return;
		const leaf = pack.leaf(path, targetFingerprint);
		if (leaf === undefined || leaf.kind === "absent") throw new Error(`durable pack target leaf 缺失：${path}`);
		relativeSafePath(canonicalRoot, path);
		await assertNoSymlinkEscape(canonicalRoot, path);
		const absolute = join(canonicalRoot, ...path.split("/"));
		directories.add(dirname(absolute));
		if (leaf.kind === "file") {
			const artifacts = pack.artifacts(path);
			if (artifacts?.target === null || artifacts?.target === undefined) {
				throw new Error(`durable finalization target artifact 缺失：${path}`);
			}
			const targetArtifact = join(canonicalRoot, ...artifacts.target.split("/"));
			const targetArtifactExists = await lstat(targetArtifact).then(() => true, (error) => {
				if (hasErrorCode(error, "ENOENT")) return false;
				throw error;
			});
			if (targetArtifactExists) {
				await assertSameFileIdentity(absolute, targetArtifact, path);
				if (await fingerprintFile(absolute, path) !== leaf.fingerprint) {
					throw new Error(`durable finalization 文件 fingerprint 冲突：${path}`);
				}
				await fsyncFile(targetArtifact);
				await assertSameFileIdentity(absolute, targetArtifact, path);
			} else {
				if (mutationStates?.get(path) !== "CLEANED") {
					throw new Error(`durable finalization target ownership 缺失：${path}`);
				}
				if (await fingerprintFile(absolute, path) !== leaf.fingerprint) {
					throw new Error(`durable finalization 文件 fingerprint 冲突：${path}`);
				}
				await fsyncFile(absolute);
			}
			if (await fingerprintFile(absolute, path) !== leaf.fingerprint) {
				throw new Error(`durable finalization 后文件 fingerprint 冲突：${path}`);
			}
			return;
		}
		if (await fingerprintSymlink(absolute, path) !== leaf.fingerprint) {
			throw new Error(`durable finalization symlink fingerprint 冲突：${path}`);
		}
		if (await fingerprintSymlink(absolute, path) !== leaf.fingerprint) {
			throw new Error(`durable finalization 后 symlink fingerprint 冲突：${path}`);
		}
	});
	for (const directory of directories) await fsyncDirectory(directory);
}

export async function removeDurablePack(journal: MutationJournal): Promise<void> {
	await rm(durablePackPath(journal), { force: true });
	await fsyncDirectory(dirname(journal.storagePath));
}

async function assertSameFileIdentity(original: string, artifact: string, logicalPath: string): Promise<void> {
	const [originalMetadata, artifactMetadata] = await Promise.all([lstat(original), lstat(artifact)]);
	if (
		!originalMetadata.isFile() ||
		!artifactMetadata.isFile() ||
		originalMetadata.dev !== artifactMetadata.dev ||
		originalMetadata.ino !== artifactMetadata.ino
	) {
		throw new Error(`durable finalization target ownership 冲突：${logicalPath}`);
	}
}

function canonicalEntries(
	entries: readonly DurablePackEntryInput[],
	validateSemanticFingerprints = true,
): DurablePackEntryInput[] {
	const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path));
	let previous: string | undefined;
	return sorted.map((entry) => {
		if (entry.path.length === 0 || entry.path.startsWith("/") || entry.path.split("/").some((part) => part === "" || part === "." || part === "..")) {
			throw new Error("durable pack path 无效");
		}
		if (entry.path === previous) throw new Error("durable pack path 重复");
		previous = entry.path;
		assertArtifact(entry.path, entry.sourceArtifact, "source");
		if (entry.targetArtifact !== null) assertArtifact(entry.path, entry.targetArtifact, "target");
		assertDigest(entry.sourceFingerprint, "sourceFingerprint");
		if (entry.targetFingerprint !== null) assertDigest(entry.targetFingerprint, "targetFingerprint");
		const variants = [...entry.variants].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
		const fingerprints = new Set<string>();
		for (const variant of variants) {
			assertDigest(variant.fingerprint, "fingerprint");
			if (fingerprints.has(variant.fingerprint)) throw new Error("durable pack variant fingerprint 重复");
			fingerprints.add(variant.fingerprint);
			if (variant.kind === "file" && (variant.mode !== 0o644 && variant.mode !== 0o755)) {
				throw new Error("durable pack file mode 无效");
			}
			const semanticFingerprint = variant.kind === "absent"
				? fingerprintAbsent(entry.path)
				: variant.kind === "file"
					? fingerprintBytes(entry.path, variant.bytes, variant.mode)
					: fingerprintSymlink(entry.path, variant.linkText);
			if (validateSemanticFingerprints && semanticFingerprint !== variant.fingerprint) {
				throw new Error(`durable pack semantic fingerprint 不匹配：${entry.path}`);
			}
		}
		if (!fingerprints.has(entry.sourceFingerprint)) throw new Error("durable pack 缺少 source variant");
		if (entry.targetFingerprint !== null && !fingerprints.has(entry.targetFingerprint)) {
			throw new Error("durable pack 缺少 target variant");
		}
		return { ...entry, variants };
	});
}

function assertPackHeader(value: unknown): PackHeader {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("durable pack header 无效");
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1 || typeof record.opId !== "string" || typeof record.planDigest !== "string" || typeof record.checksum !== "string" || !Array.isArray(record.entries)) {
		throw new Error("durable pack header 字段无效");
	}
	assertDigest(record.planDigest, "planDigest");
	assertDigest(record.checksum, "checksum");
	const entries: PackedEntryHeader[] = record.entries.map((entry): PackedEntryHeader => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("durable pack entry 无效");
		const item = entry as Record<string, unknown>;
		if (
			typeof item.path !== "string" ||
			typeof item.sourceArtifact !== "string" ||
			(item.targetArtifact !== null && typeof item.targetArtifact !== "string") ||
			typeof item.sourceFingerprint !== "string" ||
			(item.targetFingerprint !== null && typeof item.targetFingerprint !== "string") ||
			!Array.isArray(item.variants)
		) {
			throw new Error("durable pack entry 字段无效");
		}
		assertDigest(item.sourceFingerprint, "sourceFingerprint");
		if (item.targetFingerprint !== null) assertDigest(item.targetFingerprint, "targetFingerprint");
		const variants = item.variants.map((variant): PackedVariantHeader => {
			if (typeof variant !== "object" || variant === null || Array.isArray(variant)) throw new Error("durable pack variant 无效");
			const candidate = variant as Record<string, unknown>;
			if ((candidate.kind !== "absent" && candidate.kind !== "file" && candidate.kind !== "symlink") || typeof candidate.fingerprint !== "string") {
				throw new Error("durable pack variant 字段无效");
			}
			assertDigest(candidate.fingerprint, "fingerprint");
			if (candidate.kind === "file") {
				if ((candidate.mode !== 0o644 && candidate.mode !== 0o755) || !Number.isSafeInteger(candidate.offset) || !Number.isSafeInteger(candidate.length) || typeof candidate.dataChecksum !== "string") {
					throw new Error("durable pack file variant 无效");
				}
				assertDigest(candidate.dataChecksum, "dataChecksum");
				return { kind: "file", fingerprint: candidate.fingerprint, mode: candidate.mode, offset: candidate.offset as number, length: candidate.length as number, dataChecksum: candidate.dataChecksum };
			}
			if (candidate.kind === "symlink") {
				if (typeof candidate.linkText !== "string") throw new Error("durable pack symlink variant 无效");
				return { kind: "symlink", fingerprint: candidate.fingerprint, linkText: candidate.linkText };
			}
			return { kind: "absent", fingerprint: candidate.fingerprint };
		});
		return {
			path: item.path,
			sourceArtifact: item.sourceArtifact,
			targetArtifact: item.targetArtifact as string | null,
			sourceFingerprint: item.sourceFingerprint,
			targetFingerprint: item.targetFingerprint as string | null,
			variants,
		};
	});
	const payload: PackHeaderPayload = { schemaVersion: 1, opId: record.opId, planDigest: record.planDigest, entries };
	if (checksum(canonicalJson(payload)) !== record.checksum) throw new Error("durable pack header checksum 不匹配");
	canonicalEntries(entries.map((entry) => ({
		path: entry.path,
		sourceArtifact: entry.sourceArtifact,
		targetArtifact: entry.targetArtifact,
		sourceFingerprint: entry.sourceFingerprint,
		targetFingerprint: entry.targetFingerprint,
		variants: entry.variants.map((variant): DurableLeafInput => {
			if (variant.kind === "file") return { kind: "file", fingerprint: variant.fingerprint, mode: variant.mode!, bytes: new Uint8Array() };
			if (variant.kind === "symlink") return { kind: "symlink", fingerprint: variant.fingerprint, linkText: variant.linkText! };
			return { kind: "absent", fingerprint: variant.fingerprint };
		}),
	})), false);
	return { ...payload, checksum: record.checksum };
}

function durablePackFromInput(
	opId: string,
	planDigest: string,
	storagePath: string,
	packChecksum: string,
	entries: readonly DurablePackEntryInput[],
): DurablePack {
	return new DurablePack(
		opId,
		planDigest,
		storagePath,
		packChecksum,
		new Map(entries.map((entry) => [
			entry.path,
			{
				sourceArtifact: entry.sourceArtifact,
				targetArtifact: entry.targetArtifact,
				sourceFingerprint: entry.sourceFingerprint,
				targetFingerprint: entry.targetFingerprint,
				variants: new Map(entry.variants.map((variant) => [
					variant.fingerprint,
					variant.kind === "file"
						? { ...variant, bytes: new Uint8Array(variant.bytes) }
						: variant,
				])),
			},
		])),
	);
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
		if (bytesWritten <= 0) throw new Error("durable pack 写入未推进");
		offset += bytesWritten;
	}
}

function assertArtifact(path: string, artifact: string, role: "source" | "target"): void {
	const pathParts = path.split("/");
	const artifactParts = artifact.split("/");
	if (
		pathParts.slice(0, -1).join("/") !== artifactParts.slice(0, -1).join("/") ||
		!new RegExp(`^\\.pi-undo-q2-[0-9a-f]{32}-${role}$`).test(artifactParts.at(-1)!)
	) {
		throw new Error(`durable pack ${role} artifact 无效`);
	}
}

function assertDigest(value: string, name: string): void {
	if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`durable pack ${name} 无效`);
}

async function mapConcurrent<T>(
	values: readonly T[],
	concurrency: number,
	worker: (value: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	let firstFailure: unknown;
	const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
		while (firstFailure === undefined) {
			const index = next;
			next += 1;
			if (index >= values.length) return;
			try {
				await worker(values[index]!);
			} catch (error) {
				firstFailure = error;
			}
		}
	});
	await Promise.all(runners);
	if (firstFailure !== undefined) throw firstFailure;
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
