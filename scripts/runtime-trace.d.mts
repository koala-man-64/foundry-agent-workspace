import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export declare const TRACE_META: 'trace-meta';
export declare const HOST_TO_RUNTIME: 'host->runtime';
export declare const RUNTIME_TO_HOST: 'runtime->host';
export declare const RUNTIME_STDERR: 'runtime-stderr';
export declare const RUNTIME_EXIT: 'runtime-exit';

export interface TraceRecord {
  n: number;
  ms: number;
  dir: typeof TRACE_META | typeof HOST_TO_RUNTIME | typeof RUNTIME_TO_HOST | typeof RUNTIME_STDERR | typeof RUNTIME_EXIT;
  format?: number;
  roots?: string[];
  frame?: unknown;
  text?: string;
  unparsed?: number;
  oversized?: number;
  unserializable?: true;
  partial?: true;
  code?: number | null;
  signal?: string | null;
}

/** close() detaches the tap and returns the error that stopped recording, if any. */
export declare function traceRuntime(child: ChildProcessWithoutNullStreams, path: string, options?: { roots?: string[] }): { close(): Error | undefined };
export declare function readTrace(path: string): TraceRecord[];
export declare function normalizeTrace(records: TraceRecord[], options?: { roots?: string[] }): unknown[];
export declare function compareTraces(left: unknown[], right: unknown[]): { index: number; left: unknown; right: unknown }[];
export declare function incompleteTrace(records: TraceRecord[]): string | undefined;
