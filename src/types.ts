export interface PanelKvStore {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

/** D1 のうち本 Bot が利用する最小限のインターフェース (テストで差し替えるため) */
export interface DbStatement {
	bind(...values: unknown[]): DbStatement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
	run(): Promise<{ meta: { changes: number; last_row_id: number } }>;
}

export interface ReminderDb {
	prepare(query: string): DbStatement;
	/** 1 つのトランザクションで実行し、各文の結果 (RETURNING の行を含む) を返す */
	batch<T = Record<string, unknown>>(statements: DbStatement[]): Promise<{ results: T[] }[]>;
}

export interface AppBindings {
	DISCORD_APPLICATION_ID: string;
	DISCORD_PUBLIC_KEY: string;
	DISCORD_TOKEN: string;
	TARGET_CHANNEL_ID: string;
	PANEL_KV: PanelKvStore;
	REMINDER_DB: ReminderDb;
}

export interface AppEnv {
	Bindings: AppBindings;
}
