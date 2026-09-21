import { GitRunError, runSupervisedProcess } from "./git-runner.ts";
import { checkOperation, OperationError, operationProcessOptions, rethrowOperationFailure } from "./operation-context.ts";

/** 在私有目录探测，防止旧 helper 把 --capabilities 当成工作区里的请求文件。 */
export async function probeNativeCapability(
	executable: string,
	capability: string,
	isolatedDirectory: string,
): Promise<boolean> {
	const budget = operationProcessOptions(5_000);
	try {
		const result = await runSupervisedProcess({
			command: executable,
			args: ["--capabilities"],
			cwd: isolatedDirectory,
			...budget,
			outputLimitBytes: 64 * 1024,
			outputOverflow: "terminate",
		});
		if (!result.stopped) throw new GitRunError("git_termination_failed", "native 能力探测进程未能确认终止");
		if (result.outcome === "cancelled") {
			checkOperation();
			throw new OperationError("operation_cancelled", "native 能力探测已被取消");
		}
		checkOperation();
		if (result.outcome !== "exit" || result.code !== 0) return false;
		const value: unknown = JSON.parse(result.stdout.toString("utf8"));
		return typeof value === "object" && value !== null && "ok" in value && value.ok === true &&
			"capabilities" in value && Array.isArray(value.capabilities) && value.capabilities.includes(capability);
	} catch (error) {
		rethrowOperationFailure(error);
		return false;
	}
}
