import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { DbStatement, ReminderDb } from '../../src/types.ts';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

/** node:sqlite を D1 互換のインターフェースで包んだテスト用データベース (マイグレーション適用済み) */
export function createTestDb(): ReminderDb & { raw: DatabaseSync } {
	const raw = new DatabaseSync(':memory:');
	// D1 は外部キー制約が常に有効
	raw.exec('PRAGMA foreign_keys = ON;');
	// wrangler と同じくファイル名順にすべてのマイグレーションを適用する
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((name) => name.endsWith('.sql'))
		.sort()) {
		raw.exec(readFileSync(new URL(file, MIGRATIONS_DIR), 'utf-8'));
	}

	const createStatement = (query: string, values: unknown[] = []): DbStatement & { execute(): unknown } => {
		const params = values.map((value) => {
			if (value === undefined) {
				throw new Error('D1_TYPE_ERROR: Type undefined is not supported');
			}
			return value as SQLInputValue;
		});
		return {
			bind: (...next: unknown[]) => createStatement(query, next),
			first: async <T>() => (raw.prepare(query).get(...params) as T | undefined) ?? null,
			all: async <T>() => ({ results: raw.prepare(query).all(...params) as T[] }),
			run: async () => {
				const result = raw.prepare(query).run(...params);
				return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
			},
			execute: () => raw.prepare(query).run(...params),
		};
	};

	return {
		raw,
		prepare: (query: string) => createStatement(query),
		batch: async (statements: DbStatement[]) => {
			raw.exec('BEGIN');
			try {
				const results = statements.map((statement) =>
					(statement as ReturnType<typeof createStatement>).execute(),
				);
				raw.exec('COMMIT');
				return results;
			} catch (error) {
				raw.exec('ROLLBACK');
				throw error;
			}
		},
	};
}

/** 使われない前提のデータベース (呼ばれたらテストを失敗させる) */
export function createUnusedDb(): ReminderDb {
	const fail = (): never => {
		throw new Error('REMINDER_DB should not be used in this test');
	};
	return { prepare: fail, batch: fail };
}

// 本番の D1Database が ReminderDb を満たすことを型レベルで保証する
export const assertD1Compatible = (db: D1Database): ReminderDb => db;
