import { spawn } from 'child_process';
import * as path from 'path';
import { log } from '../lib/logger';

/**
 * ヘルプメッセージを表示します。
 */
function printHelp() {
	console.log(`
Usage: yarn test --case <number> [options]

Raidchainのテストケースを実行します。

必須:
  --case <number>      実行するテストケースの番号を指定します。
                       1: 単一チャンクでのアップロード上限テスト
                       2: 特定チェーンへの手動アップロードテスト
                       3: ラウンドロビン方式でのアップロードテスト
                       4: 自動負荷分散でのアップロードテスト
                       5: 水平スケーラビリティ測定テスト
                       6: チャンクサイズ最適化テスト

オプション:
  --iter <number>      テストケースを指定された回数だけ繰り返します (デフォルト: 1)。
                       ※ケース1, 5, 6は対象外です。
  --chain-counts <c1,c2,...>
                       ケース5で使用するデータチェーンの数をカンマ区切りで指定します。
                       (例: --chain-counts 1,2,3,4) (デフォルト: 1,2,4,6)
  --debug              詳細なデバッグログ（INFO, STEPなど）を有効にします。
  --help               このヘルプメッセージを表示します。

実行例:
  # ケース5(スケーラビリティ)を1,2,4,8台のチェーンでテスト
  $ just ctl-test --case 5 --chain-counts 1,2,4,8 --debug

  # ケース6(チャンクサイズ)をテスト
  $ just ctl-test --case 6 --debug
	`);
}


async function main() {
	const args = process.argv.slice(2);

	// --helpフラグがあればヘルプを表示して終了
	if (args.includes('--help')) {
		printHelp();
		process.exit(0);
	}

	// --case オプションの存在と値を確認
	const caseIndex = args.indexOf('--case');
	if (caseIndex === -1 || !args[caseIndex + 1]) {
		console.error('\nエラー: --case オプションでテスト番号を指定してください。\n');
		printHelp();
		process.exit(1);
	}

	const caseNumber = args[caseIndex + 1];
	const testFilePath = path.join(__dirname, '..', 'tests', `test-case.ts`);

	console.log(`\n--- テストケース ${caseNumber} を実行します ---`);
	log.info(`ファイル: ${testFilePath}`); // 'log' is not defined here, using console.log
	console.log(`ファイル: ${testFilePath}\n`);


	// ts-nodeに全ての引数をそのまま渡す
	const child = spawn(
		'ts-node',
		[testFilePath, ...args],
		{
			stdio: 'inherit', 
			env: {
				...process.env,
				NODE_OPTIONS: '--no-experimental-fetch'
			}
		}
	);

	child.on('close', (code) => {
		if (code !== 0) {
			console.error(`\n--- テストケース ${caseNumber} はエラーコード ${code} で終了しました ---`);
		} else {
			console.log(`\n--- テストケース ${caseNumber} は正常に終了しました ---`);
		}
		process.exit(code ?? 1);
	});

	child.on('error', (err) => {
		console.error('テストプロセスの起動に失敗しました:', err);
		process.exit(1);
	});
}

main();