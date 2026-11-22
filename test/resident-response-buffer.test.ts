import { describe, expect, it, vi } from "vitest";

import { ResidentResponseBuffer } from "../src/resident-response-buffer.ts";

describe("常驻扫描响应分行", () => {
	it("保留合并到一个块里的后续行，以及跨块的行尾", () => {
		const buffer = new ResidentResponseBuffer(100);
		buffer.append("握手\r");
		expect(buffer.takeLine()).toBeUndefined();
		buffer.append("\n初始\n\n后");
		expect(buffer.takeLine()).toBe("握手");
		expect(buffer.takeLine()).toBe("初始");
		expect(buffer.takeLine()).toBe("");
		expect(buffer.takeLine()).toBeUndefined();
		buffer.append("续\r");
		buffer.append("\n");
		expect(buffer.takeLine()).toBe("后续");
		expect(buffer.takeLine()).toBeUndefined();
	});

	it("按 UTF-8 字节限制未读总量：恰好到限可读，超一字节拒绝", () => {
		const buffer = new ResidentResponseBuffer(9);
		buffer.append("中");
		expect(buffer.takeLine()).toBeUndefined();
		expect(buffer.append("\r\n文")).toBe(true);
		expect(buffer.append("\n")).toBe(true);
		expect(buffer.append("x")).toBe(false);
		expect(buffer.takeLine()).toBe("中");
		// 首行连同 CRLF 释放五字节，第二行未消费的四字节仍计入预算。
		expect(buffer.append("123456")).toBe(false);
		expect(buffer.append("12345")).toBe(true);
		expect(buffer.takeLine()).toBe("文");
		expect(buffer.takeLine()).toBeUndefined();
		buffer.clear();
		expect(buffer.append("重新\r\n")).toBe(true);
		expect(buffer.takeLine()).toBe("重新");
	});

	it("长行按块计数，不重复计量累积的前缀", () => {
		const chunk = "x".repeat(1024);
		const chunks = 256;
		const bytes = chunk.length * chunks + 1;
		const buffer = new ResidentResponseBuffer(bytes);
		const count = vi.spyOn(Buffer, "byteLength");
		let line: string | undefined;
		let measured = 0;
		try {
			for (let i = 0; i < chunks; i++) {
				buffer.append(chunk);
				if (buffer.takeLine() !== undefined) throw new Error("不完整的行被提前返回");
			}
			buffer.append("\n");
			line = buffer.takeLine();
			for (const [value] of count.mock.calls) if (typeof value === "string") measured += value.length;
		} finally { count.mockRestore(); }
		expect(line).toBe(chunk.repeat(chunks));
		expect(measured).toBeLessThanOrEqual(2 * bytes);
	});
});
