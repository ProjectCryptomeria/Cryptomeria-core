// controller/src/strategies/upload/DistributeUploadStrategy.ts
import { CometClient } from '@cosmjs/tendermint-rpc';
import { ChainInfo, RunnerContext } from '../../types';
import { log } from '../../utils/logger';
import { sleep } from '../../utils/retry';
import { BaseMultiBurstStrategy } from './BaseMultiBurstStrategy';
// ★ 修正: ChunkLocation をインポート
import { ChunkInfo, ChunkLocation } from './BaseUploadStrategy';
import { IUploadStrategy } from './IUploadStrategy';

// Mempool 監視設定
const MEMPOOL_BYTES_LIMIT = 50 * 1024 * 1024; // 50MB
const MEMPOOL_POLL_INTERVAL_MS = 250;
const MEMPOOL_WAIT_TIMEOUT_MS = 30000; // 30秒

/**
 * 各 datachain の Mempool 状況を監視し、
 * 「マルチバースト」方式で動的に（最も空いているチェーンに）チャンクバッチを割り当てる戦略。
 */
export class DistributeUploadStrategy extends BaseMultiBurstStrategy implements IUploadStrategy {

	constructor() {
		super();
		log.debug('DistributeUploadStrategy (MultiBurst) がインスタンス化されました。');
	}

	/**
	 * 【戦略固有ロジック】
	 * Mempoolを監視し、空いているチェーンにバッチを動的に割り当てて並列処理します。
	 * ★ 修正: 戻り値を ChunkLocation[] | null に変更
	 */
	protected async distributeAndProcessMultiBurst(
		context: RunnerContext,
		allChunks: ChunkInfo[],
		estimatedGasLimit: string
	): Promise<ChunkLocation[] | null> { // ★ 修正: 戻り値の型

		const { chainManager, config } = context;

		// 1. 対象チェーンを決定 (Distribute 固有)
		const allDatachains = chainManager.getDatachainInfos();
		const chainCount = config.chainCount && typeof config.chainCount === 'number'
			? config.chainCount
			: allDatachains.length;
		const targetDatachains = allDatachains.slice(0, chainCount);

		if (targetDatachains.length === 0) {
			log.error('[DistributeUpload] 利用可能な datachain が0件です。');
			return null; // ★ 修正: 失敗
		}

		// 2. Mempool監視用のクライアントを準備 (Distribute 固有)
		const chainClients = new Map<string, CometClient>();
		for (const chain of targetDatachains) {
			try {
				const client = await this.getTmClient(context, chain.name);
				chainClients.set(chain.name, client);
			} catch (error) {
				log.error(`[DistributeUpload] Mempool監視クライアント (${chain.name}) の取得に失敗しました。`, error);
				return null; // ★ 修正: 失敗
			}
		}

		// 3. 全チャンクをバッチ化 (Distribute 固有)
		const batches = this.createBatches(allChunks, this.batchSizePerChain);
		const batchQueue = [...batches]; // コピーしてキューとして使用
		log.info(`[DistributeUpload] ${allChunks.length} チャンクを ${batches.length} バッチに分割 (BatchSize: ${this.batchSizePerChain})`);

		// 4. バッチキューとワーカープールによる動的割り当て (Distribute 固有)
		log.info(`[DistributeUpload] ${batches.length} バッチを ${targetDatachains.length} チェーン（ワーカー）で処理開始...`);

		// ★ 修正: 実績リストと処理中フラグ
		const allSuccessfulLocations: ChunkLocation[] = [];
		let processingFailed = false; // 1つでも失敗したら true
		const processingPromises = new Set<Promise<void>>();

		while (batchQueue.length > 0) {
			// ★ 修正: 既に失敗が検出されたら、新しいバッチの割り当てを停止
			if (processingFailed) {
				log.warn('[DistributeUpload] 他のバッチ処理が失敗したため、新規バッチの割り当てを停止します。');
				break;
			}

			// 4a. 空いているチェーンを探す
			const availableChain = await this.findAvailableChain(chainClients);

			if (!availableChain) {
				log.error('[DistributeUpload] 空いているチェーンが見つかりませんでした (タイムアウト)。アップロードを中断します。');
				processingFailed = true; // ★ 修正
				break; // while ループを抜ける
			}

			// 4b. キューから次のバッチを取り出す
			const nextBatch = batchQueue.shift();
			if (!nextBatch) {
				break; // キューが空になった
			}

			log.info(`[DistributeUpload] バッチ ${batches.length - batchQueue.length}/${batches.length} を ${availableChain.name} に割り当て`);

			// 4c. 基底クラスのワーカー処理を非同期で実行
			const promise = this.processBatchWorker(
				context,
				availableChain.name, // 利用可能なチェーン名
				nextBatch,
				estimatedGasLimit
			)
				.then(batchLocations => {
					// ★ 修正: 戻り値 (実績リスト or null) でハンドリング
					if (batchLocations === null) {
						log.error(`[DistributeUpload] ワーカー処理失敗 (Chain: ${availableChain.name}, Batch: ${batches.length - batchQueue.length})`);
						processingFailed = true; // 1つでも失敗したら全体を失敗とする
					} else {
						// 成功した実績を（順序不同で）追加
						allSuccessfulLocations.push(...batchLocations);
					}
				})
				.finally(() => {
					processingPromises.delete(promise); // 完了したらSetから削除
				});

			processingPromises.add(promise);
		}

		// 5. すべての処理が完了するのを待つ
		await Promise.all(Array.from(processingPromises));

		// ★ 修正: 最終結果の判定
		if (processingFailed) {
			log.error('[DistributeUpload] アップロード処理中に1つ以上のバッチが失敗しました。');
			return null;
		}

		// 順序がバラバラになっているため、インデックス番号でソートして返す
		const sortedLocations = allSuccessfulLocations.sort((a, b) => {
			const numA = parseInt(a.index.split('-').pop() ?? '0', 10);
			const numB = parseInt(b.index.split('-').pop() ?? '0', 10);
			return numA - numB;
		});

		return sortedLocations;
	}


	// --- 以下、Distribute 固有のプライベートメソッド ---

	/**
	 * Mempool に空きがあるチェーンをポーリングして探す
	 */
	private async findAvailableChain(
		chainClients: Map<string, CometClient>
	): Promise<ChainInfo | null> {

		const startTime = Date.now();
		const chainNames = Array.from(chainClients.keys());

		while (Date.now() - startTime < MEMPOOL_WAIT_TIMEOUT_MS) {
			const checks = chainNames.map(async (name) => {
				const client = chainClients.get(name)!;
				try {
					const status = await client.numUnconfirmedTxs();
					const bytes = parseInt(status.totalBytes.toString(), 10);
					return { name, bytes };
				} catch (error: any) {
					log.warn(`[Mempool] ${name} の Mempool 監視中にエラー: ${error.message}`);
					return { name, bytes: Infinity };
				}
			});

			const statuses = await Promise.all(checks);
			const bestChain = statuses.sort((a, b) => a.bytes - b.bytes)[0];

			if (bestChain && bestChain.bytes < MEMPOOL_BYTES_LIMIT) {
				log.debug(`[Mempool] 空きチェーン発見: ${bestChain.name} (Bytes: ${bestChain.bytes})`);
				return { name: bestChain.name, type: 'datachain' };
			}

			log.debug(`[Mempool] 空きチェーンなし。待機中... (Min bytes: ${bestChain?.bytes ?? 'N/A'})`);
			await sleep(MEMPOOL_POLL_INTERVAL_MS);
		}
		return null; // タイムアウト
	}

	/**
	 * RPCクライアントを context から取得 (Mempool監視用)
	 */
	private async getTmClient(context: RunnerContext, chainName: string): Promise<CometClient> {
		const { communicationStrategy, infraService } = context;

		if (communicationStrategy.constructor.name !== 'WebSocketCommunicationStrategy') {
			throw new Error(`[DistributeUpload] は WebSocketCommunicationStrategy が必要です (Mempool監視のため)。`);
		}
		const rpcEndpoints = await infraService.getRpcEndpoints();
		const rpcEndpoint = rpcEndpoints[chainName];
		if (!rpcEndpoint) throw new Error(`RPCエンドポイントが見つかりません: ${chainName}`);
		const tmClient = communicationStrategy.getRpcClient(rpcEndpoint);
		if (!tmClient) throw new Error(`RPCクライアントが取得できません: ${chainName}`);
		if (!('numUnconfirmedTxs' in tmClient)) {
			throw new Error(`[Mempool] ${chainName} のクライアントは numUnconfirmedTxs をサポートしていません (HttpBatchClient?)`);
		}
		return tmClient as CometClient;
	}
}