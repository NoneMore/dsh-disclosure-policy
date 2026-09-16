export declare const TODO_WRITE_NAME = "todo_write";
export interface GuardConfig {
  reminderAfterCalls: number;
  blockAfterCalls: number;
  progressReminderAfterCalls: number;
  progressBlockAfterCalls: number;
  progressMinChars: number;
  installProgressPolicy: boolean;
  reconcileOnTurnStop: boolean;
  exemptTools: readonly string[];
}
export declare const DEFAULT_CONFIG: GuardConfig;
export interface TodoLike { readonly status: string; }
export interface ContentBlockLike { readonly type: string; readonly text?: unknown; }
export declare function resolveConfig(input?: Partial<GuardConfig>): GuardConfig;
export declare function hasUnfinishedTodos(todos: readonly TodoLike[]): boolean;
export declare function visibleAssistantTextLength(content: readonly ContentBlockLike[]): number;
export declare function isMeaningfulVisibleAssistant(content: readonly ContentBlockLike[], minChars: number): boolean;
export declare function shouldCountTool(toolName: string, hasParent: boolean, exemptTools: ReadonlySet<string>, runCodeName?: string): boolean;
export declare function todoBlockedReason(calls: number, blockAfterCalls: number): string;
export declare function todoReminderText(calls: number, blockAfterCalls: number): string;
export declare function progressBlockedReason(calls: number, blockAfterCalls: number, minChars: number): string;
export declare function progressReminderText(calls: number, blockAfterCalls: number): string;
export declare function combinedBlockedReason(options: {
  readonly todoCalls?: number;
  readonly progressCalls?: number;
  readonly config: Pick<GuardConfig, 'blockAfterCalls' | 'progressBlockAfterCalls' | 'progressMinChars'>;
}): string;
export declare function combinedReminderText(options: {
  readonly todoCalls?: number;
  readonly progressCalls?: number;
  readonly config: Pick<GuardConfig, 'blockAfterCalls' | 'progressBlockAfterCalls'>;
}): string;
export declare const PROGRESS_POLICY_TEXT: string;
export declare const STOP_RECONCILE_TEXT: string;
