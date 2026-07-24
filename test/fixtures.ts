import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile as writeFileToDisk } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export interface TestGitRepository {
	readonly root: string;
}

export interface LocalSubmodule {
	readonly sourceRoot: string;
	readonly root: string;
}

export interface GitMetadata {
	readonly head: string;
	readonly index: Uint8Array | null;
	readonly refs: string;
}

export async function createGitRepo(root?: string): Promise<TestGitRepository> {
	const repositoryRoot = root ?? await mkdtemp(join(tmpdir(), "pi-undo-git-"));
	await mkdir(repositoryRoot, { recursive: true });
	await runGit(repositoryRoot, ["init"]);
	await runGit(repositoryRoot, ["config", "user.name", "Pi Undo Test"]);
	await runGit(repositoryRoot, ["config", "user.email", "pi-undo@example.test"]);
	await writeFile(repositoryRoot, "README.md", "fixture\n");
	await runGit(repositoryRoot, ["add", "README.md"]);
	await runGit(repositoryRoot, ["commit", "-m", "initial fixture"]);
	return { root: repositoryRoot };
}

export async function createNestedRepo(parent: string, relativePath: string): Promise<TestGitRepository> {
	return createGitRepo(join(parent, relativePath));
}

export async function createLocalSubmodule(
	parent: string,
	relativePath: string,
	source?: TestGitRepository,
): Promise<LocalSubmodule> {
	const sourceRepository = source ?? await createGitRepo();
	await runGit(parent, ["-c", "protocol.file.allow=always", "submodule", "add", "--", sourceRepository.root, relativePath]);
	await runGit(parent, ["add", ".gitmodules", relativePath]);
	await runGit(parent, ["commit", "-m", `add submodule ${relativePath}`]);
	return { sourceRoot: sourceRepository.root, root: join(parent, relativePath) };
}

export async function writeFile(root: string, relativePath: string, content: string | Uint8Array): Promise<void> {
	const target = resolve(root, relativePath);
	if (target !== root && !target.startsWith(`${root}/`)) {
		throw new Error("fixture 写入路径越界");
	}
	await mkdir(dirname(target), { recursive: true });
	await writeFileToDisk(target, content);
}

export async function readGitMetadata(root: string): Promise<GitMetadata> {
	const gitDir = (await runGit(root, ["rev-parse", "--git-dir"])).trim();
	const absoluteGitDir = resolve(root, gitDir);
	const [head, refs, index] = await Promise.all([
		readFile(join(absoluteGitDir, "HEAD"), "utf8"),
		runGit(root, ["show-ref", "--head"]),
		readFile(join(absoluteGitDir, "index")).catch(() => null),
	]);
	return { head, refs, index };
}

export async function runGit(root: string, args: readonly string[]): Promise<string> {
	const result = await executeFile("git", [...args], { cwd: root, encoding: "utf8" });
	return result.stdout;
}
