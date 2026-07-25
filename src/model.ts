export type RootState = "active" | "uninitialized" | "broken";

export type ManifestId = string & {
	readonly __manifestId: unique symbol;
};

export type TopologyFingerprint = string;
export type WorkspaceFingerprint = string;

export type ResultCode =
	| "ok"
	| "noop"
	| "busy"
	| "idle_timeout"
	| "capture_failed"
	| "restore_failed_safe"
	| "partial_restore"
	| "recovery_required"
	| "history_paused"
	| "refill_skipped"
	| "refill_failed";

export interface RootTopologyIdentity {
	readonly relativeRoot: string;
	readonly parentRoot: string | null;
	readonly state: RootState;
	readonly sourceIdentity: string;
	readonly privateRepositoryId: string;
	readonly gitlinkOid?: string;
}

export interface DiscoveryRoot extends RootTopologyIdentity {
	readonly treeId: string | null;
	readonly gitBacked: boolean;
}

export interface SnapshotRoot extends RootTopologyIdentity {
	readonly treeId: string | null;
	readonly coverage: string;
	readonly ignorePolicy: string;
	readonly ignoredPresentPaths: readonly string[];
	readonly ignoreClosure: string;
	readonly objectClosure: string;
}

export interface SnapshotManifest {
	readonly schemaVersion: 1;
	readonly manifestId: ManifestId;
	readonly workspaceIdentity: WorkspaceFingerprint;
	readonly topologyFingerprint: TopologyFingerprint;
	readonly coverage: string;
	readonly roots: readonly SnapshotRoot[];
	readonly createdAt: string;
}

export interface CheckpointRecord {
	readonly schemaVersion: 1;
	readonly checkpointId: string;
	readonly runId: string;
	readonly startEntryId: string;
	readonly userEntryId: string;
	readonly endLeafId: string;
	readonly rawPrompt: string;
	readonly beforeManifestId: ManifestId;
	readonly afterManifestId: ManifestId;
	readonly changedPaths: readonly string[];
	readonly checksum: string;
}

export interface CursorState {
	readonly schemaVersion: 1;
	readonly opId: string;
	readonly action: "undo" | "redo" | "tree";
	readonly fromLogicalLeaf: string | null;
	readonly toLogicalLeaf: string | null;
	readonly targetManifestId: ManifestId;
	readonly rollbackManifestId: ManifestId;
	readonly undoHead: string | null;
	readonly redoStack: readonly string[];
	readonly descriptorChecksum: string;
	readonly checksum: string;
}

export type JournalPhase =
	| "PREPARING"
	| "PREPARED"
	| "SESSION_MOVED"
	| "APPLYING"
	| "FILES_VERIFIED"
	| "CURSOR_COMMITTED"
	| "COMMITTED"
	| "ABORTING"
	| "ABORTED"
	| "RECOVERY_REQUIRED";

export interface OperationDescriptor {
	readonly schemaVersion: 1;
	readonly opId: string;
	readonly sessionId: string;
	readonly workspaceIdentity: WorkspaceFingerprint;
	readonly action: "undo" | "redo" | "tree";
	readonly fromLogicalLeaf: string | null;
	readonly toLogicalLeaf: string | null;
	readonly targetManifestId: ManifestId;
	readonly rollbackManifestId: ManifestId;
	readonly coverage: string;
	readonly planDigest: string;
	readonly checksum: string;
}

export interface RestorePath {
	readonly relativePath: string;
	readonly kind: "file" | "directory" | "symlink";
	readonly mode: number;
	readonly blobId: string | null;
	readonly size: number;
	readonly rootHash: string;
	readonly linkText?: string;
}
