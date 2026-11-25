import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		passWithNoTests: true,
		// Claude Code のサブエージェントや git worktree の作業ツリーにあるテストを拾わない
		exclude: [...configDefaults.exclude, '.claude/**', '.worktrees/**'],
	},
});
