import {
	createOperationScope, isUnconfirmedExit, operationHasUnconfirmedExit, runWithOperationContext,
	type OperationScope,
} from "./operation-context.ts";

/** 维护在空闲时启动；前台操作取消它并等子进程退出后再争用锁。 */
export class IdleMaintenance {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private scope: OperationScope | undefined;
	private task: Promise<void> | undefined;
	private disposed = false;

	constructor(
		private readonly isIdle: () => boolean,
		private readonly run: () => Promise<void>,
		private readonly unsafeExit: (error: unknown) => void,
		private readonly delayMs = 1_000,
	) {}

	schedule(): void {
		if (this.disposed || this.timer !== undefined || this.task !== undefined) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.disposed) return;
			if (!this.isIdle()) { this.schedule(); return; }
			const scope = createOperationScope({ timeoutMs: 300_000 });
			this.scope = scope;
			this.task = runWithOperationContext(scope.context, async () => {
				try { await this.run(); }
				catch (error) {
					if (isUnconfirmedExit(error) || operationHasUnconfirmedExit()) this.unsafeExit(error);
					// 缓存和整理失败只影响性能；取消后由下一次结算重新调度。
				}
			}).finally(() => {
				scope.dispose();
				this.scope = undefined;
				this.task = undefined;
			});
		}, this.delayMs);
		this.timer.unref();
	}

	async pause(): Promise<void> {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.scope?.cancel();
		await this.task;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.pause();
	}
}
