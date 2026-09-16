import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "todo-checkpoint-guard";
export declare const inject: string[];
export interface Config {
  reminderAfterCalls?: number;
  blockAfterCalls?: number;
  progressReminderAfterCalls?: number;
  progressBlockAfterCalls?: number;
  progressMinChars?: number;
  installProgressPolicy?: boolean;
  reconcileOnTurnStop?: boolean;
  exemptTools?: string[];
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, rawConfig?: Config): void;
export { TODO_WRITE_NAME } from './policy.js';
