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
  --case <number>    実行するテストケースの番号を指定します。
                     1: 単一チャンクでのアップロード上限テスト
                     2: 特定チェーンへの手動アップロードテスト
                     3: ラウンドロビン方式でのアップロードテスト
                     4: 自動負荷分散でのアップロードテスト

オプション:
  --iter <number>    テストケースを指定された回数だけ繰り返します (デフォルト: 1)。
                     ※ケース1は複数パラメータをテストするため対象外です。
  --debug            詳細なデバッグログ（INFO, STEPなど）を有効にします。
  --help             このヘルプメッセージを表示します。

実行例:
  # ケース3を10回繰り返し、詳細ログも表示する
  $ just ctl-test --case 3 --iter 10 --debug
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
		{ stdio: 'inherit' }
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