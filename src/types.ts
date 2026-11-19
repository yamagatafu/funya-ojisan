export interface AppBindings {
	DISCORD_APPLICATION_ID: string;
	DISCORD_PUBLIC_KEY: string;
	DISCORD_TOKEN: string;
	TARGET_CHANNEL_ID: string;
}

export interface AppEnv {
	Bindings: AppBindings;
}
