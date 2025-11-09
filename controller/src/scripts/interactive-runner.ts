// controller/src/scripts/interactive-runner.ts
import { spawn } from 'child_process';
import { prompt } from 'enquirer'; // ★ 修正: 'inquirer' ではなく 'enquirer' を使用
import * as fs from 'fs/promises';
import * as path from 'path';

// 設定ファイルがあるベースディレクトリ
const CONFIG_BASE_DIR = path.join(__dirname, '..', 'experiments', 'configs');
// 実行するスクリプト
const EXPERIMENT_RUNNER_SCRIPT = path.join(__dirname, '..', 'run-experiment.ts');

/**
 * 指定されたディレクトリ内の .config.ts ファイルを検索する
 */
async function findConfigFiles(dir: string): Promise<string[]> {
	try {
		const files = await fs.readdir(dir);
		return files.filter(f => f.endsWith('.config.ts'));
	} catch (error) {
		// ディレクトリが存在しない場合は空を返す
		return [];
	}
}

/**
 * 指定されたディレクトリ内のサブディレクトリ（カテゴリ）を検索する
 */
async function findConfigCategories(baseDir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(baseDir, { withFileTypes: true });
		return entries
			.filter(entry => entry.isDirectory())
			.map(entry => entry.name);
	} catch (error) {
		return [];
	}
}

async function runInteractive() {
	try {
		// 1. 設定ファイルディレクトリを検索
		const categories = await findConfigCategories(CONFIG_BASE_DIR);
		const rootConfigs = await findConfigFiles(CONFIG_BASE_DIR);

		const choices: { name: string, message: string, value: string }[] = [];
		let selectedConfigPath: string;

		// 選択肢を構築
		if (rootConfigs.length > 0) {
			choices.push(...rootConfigs.map(file => ({
				name: file,
				message: `(ルート) ${file}`,
				value: file, // 識別用の値
			})));
		}
		if (categories.length > 0) {
			choices.push(...categories.map(cat => ({
				name: cat,
				message: `📁 ${cat}/`,
				value: cat, // 識別用の値
			})));
		}

		if (choices.length === 0) {
			console.error(`❌ エラー: 設定ディレクトリ (${CONFIG_BASE_DIR}) に .config.ts ファイルまたはサブディレクトリが見つかりません。`);
			process.exit(1);
		}

		// 2. ユーザーにカテゴリまたはファイルを選択させる (1段階目)
		const { selectedTopLevel } = await prompt<{ selectedTopLevel: string }>({
			type: 'select',
			name: 'selectedTopLevel',
			message: '🧪 実行するテストケースのカテゴリを選択してください:',
			choices: choices,
		});

		if (selectedTopLevel.endsWith('.config.ts')) {
			// (ルート) のファイルが直接選択された場合
			selectedConfigPath = path.join('experiments', 'configs', selectedTopLevel);
		} else {
			// フォルダが選択された場合 (2段階目)
			const categoryDir = path.join(CONFIG_BASE_DIR, selectedTopLevel);
			const categoryConfigs = await findConfigFiles(categoryDir);

			if (categoryConfigs.length === 0) {
				console.error(`❌ エラー: ディレクトリ (${selectedTopLevel}) に .config.ts ファイルが見つかりません。`);
				process.exit(1);
			}

			const { selectedCase } = await prompt<{ selectedCase: string }>({
				type: 'select',
				name: 'selectedCase',
				message: `📁 ${selectedTopLevel}/ 以下のケースを選択してください:`,
				choices: categoryConfigs,
			});

			selectedConfigPath = path.join('experiments', 'configs', selectedTopLevel, selectedCase);
		}


		// 3. ログレベル選択 (enquirer 構文)
		const { logLevel } = await prompt<{ logLevel: string }>({
			type: 'select',
			name: 'logLevel',
			message: 'ログレベルを選択してください:',
			choices: [
				{ name: 'debug', message: 'DEBUG   (水色: すべて表示)' },
				{ name: 'info', message: 'INFO    (ピンク: 標準の進捗状況)' },
				{ name: 'success', message: 'SUCCESS (緑色: 主要な成功ログのみ)' },
				{ name: 'none', message: 'NONE    (無音: すべてのログを無効化)' }
			],
			initial: 1, // デフォルトを 'info' (インデックス 1) に設定
		});

		// 4. プログレスバー表示確認 (enquirer 構文)
		let showProgressBar = true;
		if (process.stdout.isTTY) {
			const { confirmProgress } = await prompt<{ confirmProgress: boolean }>({
				type: 'confirm',
				name: 'confirmProgress',
				message: '📈 プログレスバーを表示しますか？ (TTYが検出されました)',
				initial: true,
			});
			showProgressBar = confirmProgress;
		}

		// 5. run-experiment.ts に渡す引数を構築
		const args: string[] = ['--config', selectedConfigPath]; // ★ 階層パスを使用

		args.push('--logLevel', logLevel);
		if (!showProgressBar) {
			args.push('--no-progress');
		}

		console.log(`\n🚀 実験を実行します: ts-node ${path.basename(EXPERIMENT_RUNNER_SCRIPT)} ${args.join(' ')}\n`);

		// 6. ts-node を使って run-experiment.ts を実行 (変更なし)
		const tsNodePath = path.resolve(__dirname, '../../node_modules/.bin/ts-node');

		const child = spawn(
			tsNodePath,
			[EXPERIMENT_RUNNER_SCRIPT, ...args],
			{
				stdio: 'inherit',
				cwd: path.resolve(__dirname, '..', '..'),
				shell: process.platform === 'win32'
			}
		);

		child.on('error', (err) => {
			console.error(`\n❌ 子プロセスの起動に失敗しました: ${err.message}`);
			process.exitCode = 1;
		});

		child.on('close', (code) => {
			console.log(`\n🏁 実験プロセスが終了しました (終了コード: ${code})`);
			process.exitCode = code ?? 1;
		});

	} catch (error) {
		console.error('\n❌ 対話スクリプトの実行中にエラーが発生しました:', error);
		process.exit(1);
	}
}

// スクリプト実行
runInteractive();