import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";

async function main() {
	const wallet: DirectSecp256k1HdWallet = await DirectSecp256k1HdWallet.generate(24)
	const MNEMONIC = wallet.mnemonic
}

main();