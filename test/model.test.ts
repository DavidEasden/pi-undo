import { describe, expect, it } from "vitest";
import {
	assertCursor,
	assertManifest,
	canonicalJson,
	checksum,
} from "../src/encoding.ts";
import type {
	CursorState,
	ManifestId,
	SnapshotManifest,
} from "../src/model.ts";

const asManifestId = (value: string): ManifestId => value as ManifestId;

function manifest(overrides: Partial<SnapshotManifest> = {}): SnapshotManifest {
	const payload = {
		schemaVersion: 1 as const,
		workspaceIdentity: "workspace-1",
		topologyFingerprint: "topology-1",
		coverage: "complete",
		roots: [
			{
				relativeRoot: ".",
				parentRoot: null,
				state: "active" as const,
				sourceIdentity: "source-outer",
				privateRepositoryId: "repo-outer",
				treeId: "tree-outer",
			},
			{
				relativeRoot: "packages/child",
				parentRoot: ".",
				state: "active" as const,
				sourceIdentity: "source-child",
				privateRepositoryId: "repo-child",
				treeId: "tree-child",
			},
		],
		createdAt: "2026-07-24T00:00:00.000Z",
	};
	const next = { ...payload, ...overrides };
	const { manifestId: _manifestId, ...content } = next as typeof next & {
		manifestId?: ManifestId;
	};
	return {
		...next,
		manifestId: overrides.manifestId ?? asManifestId(checksum(canonicalJson(content))),
	};
}

function cursor(overrides: Partial<CursorState> = {}): CursorState {
	const payload = {
		schemaVersion: 1 as const,
		opId: "operation-1",
		action: "undo" as const,
		fromLogicalLeaf: "leaf-after",
		toLogicalLeaf: "leaf-before",
		targetManifestId: asManifestId("a".repeat(64)),
		rollbackManifestId: asManifestId("b".repeat(64)),
		undoHead: "checkpoint-1",
		redoStack: ["checkpoint-2", "checkpoint-3"],
		descriptorChecksum: "c".repeat(64),
	};
	const next = { ...payload, ...overrides };
	const { checksum: _checksum, ...content } = next as typeof next & { checksum?: string };
	return { ...next, checksum: overrides.checksum ?? checksum(canonicalJson(content)) };
}

describe("canonicalJson", () => {
	it("递归排序对象 key，并保留数组的语义顺序", () => {
		const a = canonicalJson({ z: 1, a: { y: 2, x: 3 }, items: [{ b: 2, a: 1 }, "二"] });
		const b = canonicalJson({ items: [{ a: 1, b: 2 }, "二"], a: { x: 3, y: 2 }, z: 1 });

		expect(a).toBe('{"a":{"x":3,"y":2},"items":[{"a":1,"b":2},"二"],"z":1}');
		expect(a).toBe(b);
	});

	it("不规范化 Unicode 字符串，并稳定计算文本与二进制 SHA-256", () => {
		expect(canonicalJson({ text: "你好", decomposed: "e\u0301" })).toBe(
			'{"decomposed":"é","text":"你好"}',
		);
		expect(checksum("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		expect(checksum(new Uint8Array([0, 1, 2, 255]))).toBe(
			"3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56",
		);
	});

	it("拒绝稀疏数组，避免规范编码静默改变数组内容", () => {
		const sparse = new Array(1);

		expect(() => canonicalJson(sparse)).toThrow();
	});

	it("拒绝带额外属性或 symbol 属性的数组", () => {
		const withProperty = [1] as number[] & { extra?: number };
		withProperty.extra = 2;
		const withSymbol = [1];
		Object.defineProperty(withSymbol, Symbol("extra"), { value: 2 });

		expect(() => canonicalJson(withProperty)).toThrow();
		expect(() => canonicalJson(withSymbol)).toThrow();
	});

});

describe("assertManifest", () => {
	it("接受 checksum 和 roots 顺序均规范的 manifest", () => {
		const value = manifest();

		expect(assertManifest(value)).toBe(value);
	});

	it("拒绝未知 schema version", () => {
		expect(() => assertManifest({ ...manifest(), schemaVersion: 2 })).toThrowError(
			expect.objectContaining({ code: "unsupported_schema" }),
		);
	});

	it.each(["/absolute", "../escape", "nested/../escape", "C:\\absolute", "not/canonical/"])(
		"拒绝绝对、越界或非规范 root：%s",
		(relativeRoot) => {
			const value = manifest({
				roots: [{ ...manifest().roots[0], relativeRoot }],
			});

			expect(() => assertManifest(value)).toThrowError(expect.objectContaining({ code: "invalid_root_path" }));
		},
	);

	it("拒绝未按 relativeRoot 排序的 roots", () => {
		const value = manifest({ roots: [...manifest().roots].reverse() });

		expect(() => assertManifest(value)).toThrowError(
			expect.objectContaining({ code: "noncanonical_roots" }),
		);
	});

	it("拒绝 manifest ID 校验和不匹配", () => {
		const value = manifest({ manifestId: asManifestId("0".repeat(64)) });

		expect(() => assertManifest(value)).toThrowError(expect.objectContaining({ code: "checksum_mismatch" }));
	});

	it("拒绝不存在的 parentRoot", () => {
		const value = manifest({
			roots: [
				manifest().roots[0],
				{ ...manifest().roots[1], parentRoot: "missing" },
			],
		});

		expect(() => assertManifest(value)).toThrowError(
			expect.objectContaining({ code: "invalid_manifest" }),
		);
	});

	it("拒绝跳过最近祖先的 parentRoot", () => {
		const base = manifest();
		const value = manifest({
			roots: [
				base.roots[0],
				{
					relativeRoot: "packages",
					parentRoot: ".",
					state: "active",
					sourceIdentity: "source-packages",
					privateRepositoryId: "repo-packages",
					treeId: "tree-packages",
				},
				{ ...base.roots[1], parentRoot: "." },
			],
		});

		expect(() => assertManifest(value)).toThrowError(
			expect.objectContaining({ code: "invalid_manifest" }),
		);
	});

	it("拒绝非 plain object manifest", () => {
		const value = Object.create(manifest()) as SnapshotManifest;

		expect(() => assertManifest(value)).toThrowError(
			expect.objectContaining({ code: "invalid_manifest" }),
		);
	});

	it("拒绝从原型继承 manifest 字段的对象", () => {
		const inherited = Object.create(manifest()) as Record<string, unknown>;

		expect(() => assertManifest(inherited)).toThrowError(
			expect.objectContaining({ code: "invalid_manifest" }),
		);
	});

	it("拒绝通过非枚举字段脱离 checksum 的 manifest", () => {
		const source = manifest();
		const value = { schemaVersion: 1 } as Record<string, unknown>;
		for (const [key, field] of Object.entries(source)) {
			if (key === "schemaVersion" || key === "manifestId") continue;
			Object.defineProperty(value, key, { value: field, enumerable: false });
		}
		Object.defineProperty(value, "manifestId", {
			value: asManifestId(checksum(canonicalJson({ schemaVersion: 1 }))),
			enumerable: false,
		});

		expect(() => assertManifest(value)).toThrowError(
			expect.objectContaining({ code: "invalid_manifest" }),
		);
	});

	it("拒绝缺少 workspace 根的 detached forest", () => {
		const root = { ...manifest().roots[1], relativeRoot: "child", parentRoot: null };
		const value = manifest({ roots: [root] });

		expect(() => assertManifest(value)).toThrowError(
			expect.objectContaining({ code: "invalid_manifest" }),
		);
	});
});

describe("assertCursor", () => {
	it("接受 checksum 正确的 cursor，并保留 redoStack 顺序", () => {
		const value = cursor();

		expect(assertCursor(value)).toBe(value);
		expect(assertCursor(value).redoStack).toEqual(["checkpoint-2", "checkpoint-3"]);
	});

	it("拒绝未知 schema version", () => {
		expect(() => assertCursor({ ...cursor(), schemaVersion: 2 })).toThrowError(
			expect.objectContaining({ code: "unsupported_schema" }),
		);
	});

	it("拒绝缺失 manifest ID", () => {
		expect(() => assertCursor({ ...cursor(), targetManifestId: undefined })).toThrowError(
			expect.objectContaining({ code: "invalid_manifest_id" }),
		);
	});

	it.each(["../escape", "/absolute", "nested/escape", "a\\b"]) (
		"拒绝不安全的 opId：%s",
		(opId) => {
			expect(() => assertCursor({ ...cursor(), opId })).toThrowError(
				expect.objectContaining({ code: "invalid_operation_id" }),
			);
		},
	);

	it("拒绝稀疏 redoStack", () => {
		const redoStack = new Array<string>(1);

		expect(() => assertCursor({ ...cursor(), redoStack })).toThrowError(
			expect.objectContaining({ code: "invalid_cursor" }),
		);
	});

	it("拒绝 cursor 校验和不匹配", () => {
		expect(() => assertCursor({ ...cursor(), checksum: "0".repeat(64) })).toThrowError(
			expect.objectContaining({ code: "checksum_mismatch" }),
		);
	});
});
