export type McpOperationClassification =
  | "typed_tool"
  | "batch_safe"
  | "host_only"
  | "webview_only"
  | "unsupported";

/**
 * Public MCP operation policy.
 *
 * This list is deliberately independent from the native executor vocabulary.
 * A native operation is never exposed through summer_batch merely because the
 * currently connected engine accepts it.
 */
export const MCP_OPERATION_CLASSIFICATION = {
  // Scene mutations with dedicated MCP tools that are safe in one undo group.
  AddNode: "batch_safe",
  SetProp: "batch_safe",
  SetResourceProperty: "batch_safe",
  RemoveNode: "batch_safe",
  InstantiateScene: "batch_safe",
  ConnectSignal: "batch_safe",
  ReplaceNode: "batch_safe",

  // Operations reached only through their dedicated, typed MCP tools.
  OpenScene: "typed_tool",
  SaveScene: "typed_tool",
  SelectNode: "typed_tool",
  ProjectSetting: "typed_tool",
  InputMapAddAction: "typed_tool",
  InputMapBind: "typed_tool",
  ImportFromUrl: "typed_tool",
  ImportFromUrlBatch: "typed_tool",
  GetConsoleOutput: "typed_tool",
  ClearConsoleOutput: "typed_tool",
  GetDebuggerErrors: "typed_tool",
  IsGameRunning: "typed_tool",

  // Coding hosts already provide guarded file, search, shell, and Git tools.
  WriteFile: "host_only",
  DeleteFile: "host_only",
  ReplaceText: "host_only",
  MoveFile: "host_only",
  RenameFile: "host_only",
  MakeDirectory: "host_only",
  SearchInFiles: "host_only",
  Grep: "host_only",
  RunCommand: "host_only",
  KillCommand: "host_only",
  GitStatus: "host_only",
  GitDiff: "host_only",
  GitCommit: "host_only",
  GitPush: "host_only",
  GitPull: "host_only",
  GitRestoreFiles: "host_only",
  GitRestoreWorkingTree: "host_only",

  // These require the desktop webview interaction channel, not local MCP.
  SimulateInput: "webview_only",
  AcceptAIDiff: "webview_only",
  RejectAIDiff: "webview_only",

  // No bounded public MCP contract currently exists for these operations.
  RunVerification: "unsupported",
  SummerGitRestore: "unsupported",
  SummerGitSafeRestore: "unsupported",
  SummerGitRecoverRestore: "unsupported",
  SummerGitDiffCheckpoint: "unsupported",
} as const satisfies Record<string, McpOperationClassification>;

export const MAX_BATCH_OPERATIONS = 50;

export function classifyMcpOperation(
  operation: string
): McpOperationClassification | undefined {
  return (
    MCP_OPERATION_CLASSIFICATION as Record<
      string,
      McpOperationClassification | undefined
    >
  )[operation];
}

export function isBatchSafeOperation(operation: string): boolean {
  return classifyMcpOperation(operation) === "batch_safe";
}
