import { execSync } from 'node:child_process';

const BLOCKED_BRANCHES = ['main', 'master'];

try {
	const branch = execSync('git branch --show-current').toString().trim();
	if (BLOCKED_BRANCHES.includes(branch)) {
		console.error('--------------------------------------------------');
		console.error(`Error: Direct commits to '${branch}' are not allowed.`);
		console.error('Please create a new branch and open a Pull Request.');
		console.error('--------------------------------------------------');
		console.error(`'${branch}' ブランチへの直接コミットは禁止されています。`);
		console.error('新しいブランチを作成してプルリクエストを提出してください。');
		console.error('--------------------------------------------------');
		process.exit(1);
	}
	process.exit(0);
} catch {
	console.warn('Warning: Could not determine current branch. Blocking commit as a precaution.');
	process.exit(1);
}
