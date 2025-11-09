// controller/src/scripts/interactive-runner.ts
import { spawn } from 'child_process'; // 子プロセス実行用
import { prompt } from 'enquirer'; // enquirer から prompt をインポート
import * as fs from 'fs/promises';
import * as path from 'path';

// 設定ファイルがあるディレクトリ
const CONFIG_DIR = path.join(__dirname, '..', 'experiments', 'configs');
// 実行するスクリプト
const EXPERIMENT_RUNNER_SCRIPT = path.join(__dirname, '..', 'run-experiment.ts');

async function runInteractive() {
	try {
		// 1. 設定ファイル一覧を取得
		const files = await fs.readdir(CONFIG_DIR);
		const configFiles = files.filter(f => f.endsWith('.config.ts'));

		if (configFiles.length === 0) {
			console.error(`❌ エラー: 設定ディレクトリ (${CONFIG_DIR}) に .config.ts ファイルが見つかりません。`);
			process.exit(1);
		}

		// 2. ユーザーにテストケースを選択させる
		const { selectedConfig } = await prompt<{ selectedConfig: string }>({
			type: 'select',
			name: 'selectedConfig',
			message: '🧪 実行するテストケースを選択してください:',
			choices: configFiles,
		});

		// --- ★ ステップ2: デバッグモードの有無をログレベル選択に変更 ---
		const { logLevel } = await prompt<{ logLevel: string }>({
			type: 'select',
			name: 'logLevel',
			message: 'ログレベルを選択してください (左右キーで選択):',
			choices: [
				// name が --logLevel 引数として渡される値
				{ name: 'debug', message: 'DEBUG   (水色: すべて表示)' },
				{ name: 'info', message: 'INFO    (ピンク: 標準の進捗状況)' },
				{ name: 'success', message: 'SUCCESS (緑色: 主要な成功ログのみ)' }
			],
			initial: 1, // デフォルトを 'info' (インデックス 1) に設定
		});

		// 4. run-experiment.ts に渡す引数を構築
		const configPath = path.join('experiments', 'configs', selectedConfig); // 相対パス
		const args: string[] = ['--config', configPath];

		// --- ★ '--debug' の代わりに '--logLevel' を渡す ---
		args.push('--logLevel', logLevel);

		console.log(`\n🚀 実験を実行します: ts-node ${path.basename(EXPERIMENT_RUNNER_SCRIPT)} ${args.join(' ')}\n`);

		// 5. ts-node を使って run-experiment.ts を実行
		const tsNodePath = path.resolve(__dirname, '../../node_modules/.bin/ts-node'); // ts-node のパスを取得

		const child = spawn(
			tsNodePath, // ts-node コマンド
			[EXPERIMENT_RUNNER_SCRIPT, ...args], // スクリプトパスと引数
			{
				stdio: 'inherit', // 親プロセスの標準入出力を引き継ぐ (コンソール出力が見えるように)
				cwd: path.resolve(__dirname, '..', '..'), // 'controller' ディレクトリで実行
				shell: process.platform === 'win32' // Windowsの場合シェル経由の方が安定することがある
			}
		);

		child.on('error', (err) => {
			console.error(`\n❌ 子プロセスの起動に失敗しました: ${err.message}`);
			process.exitCode = 1;
		});

		child.on('close', (code) => {
			console.log(`\n🏁 実験プロセスが終了しました (終了コード: ${code})`);
			process.exitCode = code ?? 1; // エラーコードを引き継ぐ
		});

	} catch (error) {
		console.error('\n❌ 対話スクリプトの実行中にエラーが発生しました:', error);
		process.exit(1);
	}
}

// スクリプト実行
runInteractive();