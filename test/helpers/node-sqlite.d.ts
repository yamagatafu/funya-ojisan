// @types/node を導入せずにテストで node:sqlite を使うための最小限の型宣言
declare module 'node:sqlite' {
	export type SQLInputValue = null | number | bigint | string | Uint8Array;

	export interface StatementSync {
		get(...params: SQLInputValue[]): unknown;
		all(...params: SQLInputValue[]): unknown[];
		run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
	}

	export class DatabaseSync {
		constructor(path: string);
		exec(sql: string): void;
		prepare(sql: string): StatementSync;
	}
}

declare module 'node:fs' {
	export function readFileSync(path: URL | string, encoding: 'utf-8'): string;
}
