// controller/src/scripts/monitor-chain.ts
import { toBech32 } from '@cosmjs/encoding';
import { Coin, StargateClient } from '@cosmjs/stargate';
import { BlockResponse, CometClient, Header } from '@cosmjs/tendermint-rpc';
import { NewBlockEvent } from '@cosmjs/tendermint-rpc/build/comet38/responses';

import { AccountData } from '@cosmjs/proto-signing';
import { ChainManager } from '../core/ChainManager';
import { InfrastructureService } from '../infrastructure/InfrastructureService';
import { WebSocketCommunicationStrategy } from '../strategies/communication/WebSocketCommunicationStrategy';
import { log } from '../utils/logger';

// =================================================================================================
// 📚 I. CONFIG
// =================================================================================================

/**
 * すべての設定値をここに集約
 */
const CONFIG = {
	// 監視対象のチェーン名 (例: 'data-0', 'meta-0')
	TARGET_CHAIN_NAME: 'data-0',
	// Cosmos SDK のデフォルトのプレフィックス
	BECH32_PREFIX: 'cosmos',
};

// =================================================================================================
// 📝 II. LOGGER (既存のロガーを使用)
// =================================================================================================

// controller/src/utils/logger の 'log' オブジェクトを直接使用

// =================================================================================================
// 💻 III. KUBERNETES UTILITIES (InfrastructureService を使用)
// =================================================================================================

// InfrastructureService がすべて担当 (コード不要)

// =================================================================================================
// 🚀 IV. CHAIN CLIENT MANAGEMENT (core/ChainManager を使用)
// =================================================================================================

// core/ChainManager を使用 (コード不要)

// =================================================================================================
// ⚙️ V. CORE BUSINESS LOGIC (MAIN)
// =================================================================================================

/**
 * TendermintのValidatorコンセンサスアドレス(Proposer Address)から、
 * 対応するCosmos SDKのアカウントアドレスを取得する。
 */
function getCosmosAccountAddressFromProposer(proposerAddress: Uint8Array): string {
	const proposerHex = Buffer.from(proposerAddress).toString('hex').toUpperCase();
	try {
		const cosmosAddress = toBech32(CONFIG.BECH32_PREFIX, proposerAddress);
		return cosmosAddress;
	} catch (e: any) {
		log.warn(`[ADDR_CONV_ERROR] Failed to convert proposer address ${proposerHex} to Cosmos address:`, e.message);
		return `TENDERMINT_HEX:${proposerHex}`;
	}
}

/**
 * 特定のCosmosアドレスの残高を取得する
 */
async function getAccountBalances(client: StargateClient, address: string): Promise<readonly Coin[]> {
	try {
		const balances = await client.getAllBalances(address);
		return balances;
	} catch (e: any) {
		log.error(`[BALANCE_QUERY_ERROR] Failed to fetch balances for ${address}:`, e.message);
		return [{ amount: 'ERROR', denom: 'ERROR' }];
	}
}

/**
 * ブロック生成イベントの監視を開始する
 */
async function startBlockMonitoring(
	chainName: string,
	tmClient: CometClient,
	queryClient: StargateClient,
	creatorAccount: AccountData
): Promise<void> {

	log.info(`✅ ${chainName} のブロック生成イベントの購読を開始しました。`);

	const subscription = tmClient.subscribeNewBlock();

	subscription.addListener({
		next: async (event: NewBlockEvent) => {
			try {
				const blockHeader: Header = event.header;
				const height: number = blockHeader.height;
				const blockTxs: readonly Uint8Array[] = event.txs;

				if (!blockHeader) {
					log.warn(`[EVENT_PARSE] Received NewBlockEvent but could not find header data:`, event);
					return;
				}

				let blockHash: Uint8Array;
				try {
					// @ts-ignore (tmClient.block の戻り値の型が BlockResponse であることを期待)
					const blockRpcResponse: BlockResponse = await tmClient.block(height);

					if (blockRpcResponse && (blockRpcResponse as any).blockId) {
						// @ts-ignore
						blockHash = (blockRpcResponse as any).blockId.hash;
					} else {
						log.warn(`[RPC_ERROR] tmClient.block(${height}) の応答に blockId が見つかりません。lastCommitHash で代替します。`);
						blockHash = blockHeader.lastCommitHash; // Fallback
					}
				} catch (e: any) {
					log.error(`[RPC_ERROR] Failed to fetch block details for height ${height}. Falling back to lastCommitHash:`, e.message);
					blockHash = blockHeader.lastCommitHash; // Fallback
				}

				const proposerTendermintAddress = blockHeader.proposerAddress; // Uint8Array
				const proposerCosmosAddress = getCosmosAccountAddressFromProposer(proposerTendermintAddress);

				const clientAddress = creatorAccount.address;
				let clientBalances: readonly Coin[] = [];

				try {
					clientBalances = await getAccountBalances(queryClient, clientAddress);
				} catch (e: any) {
					log.error(`[CLIENT_BALANCE_ERROR] Failed to get client balance for ${clientAddress}:`, e.message);
					clientBalances = [{ amount: 'ERROR', denom: 'QUERY_FAILED' }];
				}

				log.info(`--------------------------------------------------------------------------------`);
				log.info(`🧱 NEW BLOCK | CHAIN: ${chainName}`);
				log.info(`- HEIGHT: ${height}`);
				log.info(`- HASH: ${Buffer.from(blockHash).toString('hex').toUpperCase()}`);
				log.info(`- TIME: ${blockHeader.time.toISOString()}`);
				log.info(`- TX COUNT: ${blockTxs.length}`);
				log.info(`- PROPOSER (Consensus Key): ${Buffer.from(proposerTendermintAddress).toString('hex').toUpperCase()}`);
				log.info(`- PROPOSER (Cosmos Address): ${proposerCosmosAddress}`);
				log.info(`- CLIENT (Address): ${clientAddress}`);
				log.info(`- CLIENT (Balance): ${clientBalances.map(b => `${b.amount}${b.denom}`).join(', ')}`);
				log.info(`- TRANSACTIONS[${blockTxs.length}]:`);
				if (blockTxs.length > 0) {
					blockTxs.forEach((txBytes: Uint8Array, index: number) => {
						const txBase64 = txBytes
							? Buffer.from(txBytes).toString('base64').substring(0, 40) + '...'
							: 'N/A';
						log.info(`  [${index}]: ${txBase64}`);
					});
				}
				log.info(`--------------------------------------------------------------------------------`);

			} catch (processingError) {
				log.error(`[EVENT_PROCESS_ERROR] Failed to process NewBlockEvent:`, processingError);
			}
		},
		error: (err: any) => {
			log.error(`[STREAM_ERROR] Block subscription error on ${chainName}:`, err);
		},
		complete: () => {
			log.warn(`[STREAM_COMPLETE] Block subscription unexpectedly completed on ${chainName}.`);
		},
	});

	return new Promise<void>(() => { });
}

/**
 * メインの監視処理
 */
async function main() {
	const infraService = new InfrastructureService();
	const commStrategy = new WebSocketCommunicationStrategy();
	const chainManager = new ChainManager();

	log.info(`===== Chain Monitor for [${CONFIG.TARGET_CHAIN_NAME}] Starting =====`);

	// ★★★ 修正点 1 ★★★
	// ログレベルを 'debug' から 'info' に変更
	log.setLogLevel('info');

	try {
		// 1. 環境設定とクライアント初期化
		await chainManager.init(infraService, commStrategy);
		log.success('ChainManager initialized.');

		// 2. 監視対象チェーンのクライアントを取得
		const chainName = CONFIG.TARGET_CHAIN_NAME;
		const { queryClient, wallet } = chainManager.getChainAccount(chainName);

		// 3. CometClient (Tendermint) を取得
		const rpcEndpoints = await infraService.getRpcEndpoints();
		const rpcEndpoint = rpcEndpoints[chainName];
		if (!rpcEndpoint) {
			throw new Error(`RPC endpoint for ${chainName} not found.`);
		}
		const tmClient = commStrategy.getRpcClient(rpcEndpoint);
		if (!tmClient || !('subscribeNewBlock' in tmClient)) {
			throw new Error(`Failed to get WebSocket CometClient (tmClient) from CommStrategy for chain ${chainName}`);
		}

		// 4. アカウント情報を取得
		const [creatorAccount] = await wallet.getAccounts();
		if (!creatorAccount) {
			throw new Error(`Failed to get account from wallet for chain ${chainName}`);
		}

		// 5. ブロック監視の開始
		await startBlockMonitoring(chainName, tmClient as CometClient, queryClient, creatorAccount);

	} catch (err) {
		log.error('[MAIN] A fatal error occurred:', err);
		throw err;
	}
}

// 実行と最終的なエラーハンドリング
main().catch(async err => {
	log.error('Uncaught fatal error in main execution loop:', err);
	await log.flushErrorLogs();
	process.exit(1);
});