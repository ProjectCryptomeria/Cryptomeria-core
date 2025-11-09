// controller/src/strategies/upload/DistributeUploadStrategy.ts
import { CometClient } from '@cosmjs/tendermint-rpc';
import { ChainInfo, RunnerContext } from '../../types';
import { log } from '../../utils/logger';
import { IProgressBar } from '../../utils/ProgressManager/IProgressManager';
import { sleep } from '../../utils/retry';
import { BaseMultiBurstStrategy } from './BaseMultiBurstStrategy';
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
	 * (★ 修正: バーの初期化と完了処理)
	 */
	protected async distributeAndProcessMultiBurst(
		context: RunnerContext,
		allChunks: ChunkInfo[],
		estimatedGasLimit: string
	): Promise<ChunkLocation[] | null> {

		const { chainManager, progressManager } = context;

		// 1. 対象チェーンを決定
		const allDatachains = chainManager.getDatachainInfos();
		const task = context.currentTask;
		if (!task) {
			throw new Error('DistributeUploadStrategy: context.currentTask が設定されていません。');
		}
		const chainCount = task.chainCount && typeof task.chainCount === 'number'
			? task.chainCount
			: allDatachains.length;
		const targetDatachains = allDatachains.slice(0, chainCount);

		if (targetDatachains.length === 0) {
			log.error('[DistributeUpload] 利用可能な datachain が0件です。');
			return null;
		}

		// ★★★ 修正点 1: バーの初期化 (total: 0) ★★★
		const chainBars = new Map<string, IProgressBar>();
		for (const chain of targetDatachains) {
			// total = 0 で初期化し、バッチ割り当て時に setTotal で動的に更新する
			const bar = progressManager.addBar(chain.name.padEnd(8), 0, 0, { status: 'Waiting...' });
			chainBars.set(chain.name, bar);
		}

		// 2. Mempool監視用のクライアントを準備
		const chainClients = new Map<string, CometClient>();
		for (const chain of targetDatachains) {
			try {
				const client = await this.getTmClient(context, chain.name);
				chainClients.set(chain.name, client);
			} catch (error) {
				log.error(`[DistributeUpload] Mempool監視クライアント (${chain.name}) の取得に失敗しました。`, error);
				return null;
			}
		}

		// 3. 全チャンクをバッチ化
		const batches = this.createBatches(allChunks, this.batchSizePerChain);
		const batchQueue = [...batches];
		log.info(`[DistributeUpload] ${allChunks.length} チャンクを ${batches.length} バッチに分割 (BatchSize: ${this.batchSizePerChain})`);

		// 4. バッチキューとワーカープールによる動的割り当て
		log.info(`[DistributeUpload] ${batches.length} バッチを ${targetDatachains.length} チェーン（ワーカー）で処理開始...`);

		const allSuccessfulLocations: ChunkLocation[] = [];
		let processingFailed = false;
		const processingPromises = new Set<Promise<void>>();

		// ★ 修正点 2: 実際にチェーンに割り当てたチャンク数を追跡
		const actualChunksAssigned = new Map<string, number>();
		targetDatachains.forEach(c => actualChunksAssigned.set(c.name, 0));

		try {
			while (batchQueue.length > 0) {
				if (processingFailed) {
					log.warn('[DistributeUpload] 他のバッチ処理が失敗したため、新規バッチの割り当てを停止します。');
					break;
				}

				const availableChain = await this.findAvailableChain(
					chainClients,
					chainBars
				);

				if (!availableChain) {
					log.error('[DistributeUpload] 空いているチェーンが見つかりませんでした (タイムアウト)。アップロードを中断します。');
					processingFailed = true;
					break;
				}

				const availableChainName = availableChain.name;
				const bar = chainBars.get(availableChainName)!;

				const nextBatch = batchQueue.shift();
				if (!nextBatch) {
					break;
				}

				// ★ 修正点 3: バーの最大値(Total)を動的に *調整* する
				const currentAssigned = actualChunksAssigned.get(availableChainName) ?? 0;
				const newTotalAssigned = currentAssigned + nextBatch.chunks.length;
				actualChunksAssigned.set(availableChainName, newTotalAssigned);
				bar.setTotal(newTotalAssigned); // (total を累積で更新)

				bar.updatePayload({ status: 'Batch Assigned' });
				log.info(`[DistributeUpload] バッチ ${batches.length - batchQueue.length}/${batches.length} を ${availableChainName} に割り当て`);

				const promise = this.processBatchWorker(
					context,
					availableChainName,
					nextBatch,
					estimatedGasLimit,
					bar
				)
					.then(batchLocations => {
						if (batchLocations === null) {
							log.error(`[DistributeUpload] ワーカー処理失敗 (Chain: ${availableChainName}, Batch: ${batches.length - batchQueue.length})`);
							processingFailed = true;
						} else {
							allSuccessfulLocations.push(...batchLocations);
						}
					})
					.finally(() => {
						processingPromises.delete(promise);
					});

				processingPromises.add(promise);
			}

			// 5. すべての処理が完了するのを待つ
			await Promise.all(Array.from(processingPromises));

		} catch (error) {
			log.error(`[DistributeUpload] 処理ループ中に予期せぬエラーが発生しました。`, error);
			processingFailed = true;
		} finally {
			// ★★★ 修正点 4: 完了処理 (見栄え修正) ★★★
			chainBars.forEach((bar, name) => {
				const totalAssigned = actualChunksAssigned.get(name) ?? 0;

				if (processingFailed) {
					// 失敗時は、現在の進捗のままステータスを Failed にする
					// (ただし、onProgress で 'Batch Failed!' になっている可能性もある)
					if (bar.getTotal() > 0) {
						bar.updatePayload({ status: 'Failed!' });
					} else {
						bar.update(0, { status: 'Failed (0 Tx)' });
					}
				} else if (totalAssigned === 0) {
					// 正常終了したが、何も割り当てられなかった場合
					// total: 0 のまま value: 0 をセットし、100% (0/0) にする
					bar.update(0, { status: 'Done (0 Tx)' });
				} else {
					// 正常終了し、割り当てがあった場合
					// (onProgress で 'Batch Done' になっているはずだが、
					//  Mempool 待ちなどで終わった場合のために 'Done' にする)
					bar.update(totalAssigned, { status: 'Done' });
				}
			});
		}


		if (processingFailed) {
			log.error('[DistributeUpload] アップロード処理中に1つ以上のバッチが失敗しました。');
			return null;
		}

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
		chainClients: Map<string, CometClient>,
		chainBars: Map<string, IProgressBar>
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
					chainBars.get(name)?.updatePayload({ status: 'Mempool Error!' });
					return { name, bytes: Infinity };
				}
			});

			const statuses = await Promise.all(checks);
			const bestChain = statuses.sort((a, b) => a.bytes - b.bytes)[0];

			if (bestChain && bestChain.bytes < MEMPOOL_BYTES_LIMIT) {
				log.debug(`[Mempool] 空きチェーン発見: ${bestChain.name} (Bytes: ${bestChain.bytes})`);
				chainBars.get(bestChain.name)?.updatePayload({ status: 'Mempool Ready' });
				return { name: bestChain.name, type: 'datachain' };
			}

			// Mempool 待ちのステータス更新
			statuses.forEach(status => {
				const bar = chainBars.get(status.name);
				if (!bar) return;

				// (バーの現在の値を取得する機能は IProgressBar にはないため、
				//  ステータスが 'Confirming' などで上書きされるのを防ぐロジックは省略)

				if (status.bytes >= MEMPOOL_BYTES_LIMIT) {
					const bytesMB = (status.bytes / 1024 / 1024).toFixed(1);
					bar.updatePayload({ status: `Mempool Full (${bytesMB}MB)` });
				}
			});

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