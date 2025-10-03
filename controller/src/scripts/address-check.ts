import { HdPath, stringToPath,Bip39 } from "@cosmjs/crypto";
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { getCreatorMnemonic } from '../config';

async function main() {
	console.log('🔬 Starting address derivation check...');

	new Bip39(); // 依存関係の問題を避けるためにBip39を一度参照

	try {
		// 1. data-0チェーンのニーモニックをK8s Secretから取得
		const chainName = 'data-0';
		const mnemonic = await getCreatorMnemonic(chainName);
		console.log(`✅ Fetched mnemonic for "${chainName}"`);

		// 2. HDウォレットの導出パスを明示的に指定
		const hdPathString = "m/44'/118'/0'/0/2";
		const hdPath: HdPath = stringToPath(hdPathString);
		console.log(`✅ Using HD Path: "${hdPathString}"`);

		// 3. ニーモニックからウォレットを生成
		const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
			prefix: 'cosmos',
			hdPaths: [hdPath]
		});

		// 4. ウォレットからアカウント情報を取得
		const [account] = await wallet.getAccounts();
		if (!account) {
			throw new Error('Could not get account from wallet');
		}

		// 5. 生成されたアドレスを表示
		console.log('\n--------------------------------------------------');
		console.log(`👁️  Derived Address: ${account.address}`);
		console.log('--------------------------------------------------');

		console.log('\n🎉 Check complete! Please compare this address with the one on the chain.');

	} catch (err) {
		console.error('🔥 An error occurred during the address check:');
		if (err instanceof Error) {
			console.error(err.message);
		} else {
			console.error(err);
		}
		process.exit(1);
	}
}

main();