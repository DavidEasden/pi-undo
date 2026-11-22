/** 输入来自 setEncoding("utf8")，不会切开码点。上限包含所有未消费的字节（含换行）。 */
export class ResidentResponseBuffer {
	private readonly fragments: string[] = [];
	private tail = "";
	private bytes = 0;

	constructor(private readonly maxBytes: number) {}

	append(chunk: string): boolean {
		const bytes = this.bytes + Buffer.byteLength(chunk, "utf8");
		if (bytes > this.maxBytes) return false;
		this.bytes = bytes;
		this.tail += chunk;
		return true;
	}

	takeLine(): string | undefined {
		if (this.tail.length === 0) return undefined;
		const newline = this.tail.indexOf("\n");
		if (newline < 0) {
			// 已找过换行的片段不再参与查找；等整行就绪再一次性拼接。
			this.fragments.push(this.tail);
			this.tail = "";
			return undefined;
		}
		let line = this.tail.slice(0, newline);
		this.tail = this.tail.slice(newline + 1);
		if (this.fragments.length > 0) {
			this.fragments.push(line);
			line = this.fragments.join("");
			this.fragments.length = 0;
		}
		this.bytes = this.tail.length === 0 ? 0 : this.bytes - Buffer.byteLength(line, "utf8") - 1;
		return line.endsWith("\r") ? line.slice(0, -1) : line;
	}

	clear(): void {
		this.fragments.length = 0;
		this.tail = "";
		this.bytes = 0;
	}
}
