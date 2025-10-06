import { HdPath, stringToPath } from "@cosmjs/crypto";
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { getChainConfig } from '../config';
import { getCreatorMnemonic } from '../lib/k8s-client'; // CHANGED: Import from k8s-client

async function main() {
	console.log('🔬 Starting address derivation check...');

	try {
		const config = await getChainConfig();
		const chains = Object.keys(config);

		if (chains.length === 0) {
			console.error('No chains found in the configuration. Please check your setup.');
			return;
		}

		console.log(`Found ${chains.length} chains to check: ${chains.join(', ')}`);

		for (const chainName of chains) {
			try {
				console.log(`\n--- Checking chain: ${chainName} ---`);
				const mnemonic = await getCreatorMnemonic(chainName);

				const hdPathString = "m/44'/118'/0'/0/2";
				const hdPath: HdPath = stringToPath(hdPathString);

				const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
					prefix: config[chainName]!.prefix,
					hdPaths: [hdPath]
				});

				const [account] = await wallet.getAccounts();
				if (!account) {
					throw new Error('Could not get account from wallet');
				}

				console.log(`✅ Derived Address: ${account.address}`);

			} catch (err) {
				console.error(`🔥 An error occurred while checking chain ${chainName}:`);
				if (err instanceof Error) {
					console.error(err.message);
				} else {
					console.error(err);
				}
			}
		}

		console.log('\n🎉 Check complete!');

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