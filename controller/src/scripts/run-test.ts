import { spawn } from 'child_process';
import * as path from 'path';

async function main() {
	// コマンドライン引数を解析
	const args = process.argv.slice(2);
	const caseIndex = args.indexOf('--case');

	if (caseIndex === -1 || !args[caseIndex + 1]) {
		console.error('エラー: --case オプションでテスト番号 (1, 2, 3...) を指定してください。');
		console.error('例: yarn test --case 1');
		process.exit(1);
	}

	const caseNumber = args[caseIndex + 1];
	const testFilePath = path.join(__dirname, '..', 'tests', `case${caseNumber}.ts`);

	console.log(`\n--- テストケース ${caseNumber} を実行します ---`);
	console.log(`ファイル: ${testFilePath}\n`);

	// ts-nodeを使って指定されたテストファイルを実行
	const child = spawn(
		'ts-node',
		[testFilePath],
		{ stdio: 'inherit' } // 親プロセスの標準入出力を共有
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