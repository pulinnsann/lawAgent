import type { ReviewTask } from '../shared/contracts';

export interface DesktopHost {
  call<T = unknown>(operation: string, payload: unknown): Promise<T>;
  emitTask(task: ReviewTask): void;
  emitShutdownProgress?(phase: 'draining'): void;
}
export type DesktopResult = {ok: true; data: unknown} | {ok: false; error: string};
export interface DesktopRuntime {
  invoke(envelope: unknown): Promise<DesktopResult>;
  close(): Promise<void>;
  isMaintenanceBusy?(): boolean;
}
export type ParentFrame =
  | {type: 'invoke'; id: string; name: string; payload?: unknown}
  | {type: 'hostResponse'; id: string; data?: unknown; error?: string}
  | {type: 'shutdown'; id: string};
export type BackendFrame =
  | {type: 'ready'; protocol: 1}
  | {type: 'response'; id: string; data?: DesktopResult; error?: string}
  | {type: 'host'; id: string; operation: string; payload: unknown}
  | {type: 'task'; task: ReviewTask}
  | {type: 'shutdownComplete'; id: string}
  | {type: 'shutdownDeferred'; id: string; reason: 'maintenance'}
  | {type: 'shutdownProgress'; phase: 'draining'}
  | {type: 'fatal'; error: string};
