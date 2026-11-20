export interface PanelKvStore {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
}

export interface AppBindings {
	DISCORD_APPLICATION_ID: string;
	DISCORD_PUBLIC_KEY: string;
	DISCORD_TOKEN: string;
	TARGET_CHANNEL_ID: string;
	PANEL_KV?: PanelKvStore;
}

export interface AppEnv {
	Bindings: AppBindings;
}
