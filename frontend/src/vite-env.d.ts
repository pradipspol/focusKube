/// <reference types="vite/client" />

interface Window {
	desktopMenu?: {
		onAction: (handler: (action: 'preferences' | 'release-notes' | 'license' | 'about') => void) => () => void;
		openExternal: (url: string) => Promise<void>;
		fetchGithubFile: (path: string) => Promise<string>;
		fetchLatestRelease: () => Promise<{ name: string; body: string }>;
		getAppInfo: () => Promise<{ name: string; version: string; description: string }>;
		setTheme: (theme: 'dark' | 'light' | 'contrast') => Promise<void>;
	};
}

interface ImportMetaEnv {
	readonly K8_EXPLORER_DESKTOP?: string;
}
