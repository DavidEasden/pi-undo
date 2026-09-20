import { describe, expect, it } from "vitest";

import {
	checkOperation,
	createOperationScope,
	currentOperationContext,
	operationProcessOptions,
	type OperationContext,
	reportOperationProgress,
	runWithOperationContext,
} from "../src/operation-context.ts";

function contextWith(options: { readonly timeoutMs?: number } = {}): OperationContext {
	return {
		signal: new AbortController().signal,
		deadline: options.timeoutMs === undefined
			? Number.POSITIVE_INFINITY
			: Date.now() + options.timeoutMs,
	};
}

describe("operation context", () => {
	it("在 context 内传播并返回 body 结果", async () => {
		const context = contextWith();
		const result = await runWithOperationContext(context, async () => {
			await Promise.resolve();
			return currentOperationContext();
		});

		expect(result).toBe(context);
	});

	it("没有 context 时 currentOperationContext 与 checkOperation 都是空操作", () => {
		expect(currentOperationContext()).toBeUndefined();
		expect(() => checkOperation()).not.toThrow();
		expect(operationProcessOptions()).toEqual({ timeoutMs: 120_000 });
	});

	it("undefined 清除继承的 context，而不是复用外层", () => {
		const outer = contextWith();
		runWithOperationContext(outer, () => {
			expect(currentOperationContext()).toBe(outer);
			runWithOperationContext(undefined, () => {
				expect(currentOperationContext()).toBeUndefined();
				expect(() => checkOperation()).not.toThrow();
			});
			expect(currentOperationContext()).toBe(outer);
		});
	});

	it("signal aborted 时抛 operation_cancelled", () => {
		const controller = new AbortController();
		controller.abort();

		expect(() => runWithOperationContext(
			{ signal: controller.signal, deadline: Number.POSITIVE_INFINITY },
			() => checkOperation(),
		)).toThrow(expect.objectContaining({ code: "operation_cancelled" }));
	});

	it("deadline 过期时抛 operation_timeout", () => {
		expect(() => runWithOperationContext(
			{ signal: new AbortController().signal, deadline: Date.now() - 1 },
			() => checkOperation(),
		)).toThrow(expect.objectContaining({ code: "operation_timeout" }));
	});

	it("区分超时 reason 与主动取消", async () => {
		const scope = createOperationScope({ timeoutMs: 10 });
		try {
			expect(() => runWithOperationContext(scope.context, () => checkOperation())).not.toThrow();
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(() => runWithOperationContext(scope.context, () => checkOperation()))
				.toThrow(expect.objectContaining({ code: "operation_timeout" }));
		} finally {
			scope.dispose();
		}
	});

	it("createOperationScope 的 cancel 产生 operation_cancelled，父 signal 也会传播", () => {
		const parent = new AbortController();
		const scope = createOperationScope({ timeoutMs: 60_000, signal: parent.signal });
		try {
			parent.abort();
			expect(() => runWithOperationContext(scope.context, () => checkOperation()))
				.toThrow(expect.objectContaining({ code: "operation_cancelled" }));
		} finally {
			scope.dispose();
		}

		const own = createOperationScope();
		own.cancel();
		expect(() => runWithOperationContext(own.context, () => checkOperation()))
			.toThrow(expect.objectContaining({ code: "operation_cancelled" }));
		own.dispose();
	});

	it("operationProcessOptions 取剩余 deadline 与默认值的较小者并带上 signal", () => {
		const context = contextWith({ timeoutMs: 5_000 });

		const budget = runWithOperationContext(context, () => operationProcessOptions(120_000));

		expect(budget.signal).toBe(context.signal);
		expect(budget.timeoutMs).toBeLessThanOrEqual(5_000);
		expect(budget.timeoutMs).toBeGreaterThan(4_000);

		const defaulted = runWithOperationContext(contextWith({ timeoutMs: 600_000 }), () => operationProcessOptions());
		expect(defaulted.timeoutMs).toBe(120_000);
	});

	it("operationProcessOptions 在已取消或已超时时拒绝继续", () => {
		const controller = new AbortController();
		controller.abort();
		expect(() => runWithOperationContext(
			{ signal: controller.signal, deadline: Number.POSITIVE_INFINITY },
			() => operationProcessOptions(),
		)).toThrow(expect.objectContaining({ code: "operation_cancelled" }));

		expect(() => runWithOperationContext(
			{ signal: new AbortController().signal, deadline: Date.now() - 1 },
			() => operationProcessOptions(),
		)).toThrow(expect.objectContaining({ code: "operation_timeout" }));
	});

	it("reportOperationProgress 转发可读阶段，没有回调时静默", () => {
		const phases: string[] = [];
		runWithOperationContext(
			{ signal: new AbortController().signal, deadline: Number.POSITIVE_INFINITY, onProgress: (phase) => phases.push(phase) },
			() => reportOperationProgress("scan_directories"),
		);
		expect(phases).toEqual(["scan_directories"]);
		expect(() => reportOperationProgress("discover_roots")).not.toThrow();
	});
});
