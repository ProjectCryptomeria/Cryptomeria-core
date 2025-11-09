// controller/src/strategies/upload/implement/allocator/AvailableAllocator.ts
import { CometClient } from '@cosmjs/tendermint-rpc';
import { ChainInfo, RunnerContext } from '../../../../types';
import { log } from '../../../../utils/logger';
import { IProgressBar } from '../../../../utils/ProgressManager/IProgressManager';
import { sleep } from '../../../../utils/retry';
import { BaseCoreLogic, ChunkInfo, UploadJob } from '../../base/BaseCoreLogic';
import { IChunkAllocator } from '../../interfaces/IChunkAllocator';

// Mempool 監視設定 (旧 DistributeUploadStrategy から)
const MEMPOOL_BYTES_LIMIT = 50 * 1024 * 1024; // 50MB
const MEMPOOL_POLL_INTERVAL_MS = 250;
const MEMPOOL_WAIT_TIMEOUT_MS = 30000; // 30秒
const DEFAULT_BATCH_SIZE_PER_CHAIN = 100;

/**
 * 「共通キュー」＋「空き選択」割当ロジック。
 * Mempoolを監視し、最も空いているチェーンにバッチを動的に割り当てる。
 * (旧 DistributeUploadStrategy のスケジューリングロジック)
 */
export class AvailableAllocator implements IChunkAllocator {
	private coreLogic: BaseCoreLogic;
	private chainClients = new Map<string, CometClient>();
	// ★★★ 修正: private -> public ★★★
	public chainBars = new Map<string, IProgressBar>();

	constructor() {
		log.debug('AvailableAllocator がインスタンス化されました。');
		this.coreLogic = new BaseCoreLogic();
	}

	/**
	 * Mempoolを監視し、空いているチェーンにバッチを動的に割り当てます。
	 */
	public async allocateChunks(
		context: RunnerContext,
		allChunks: ChunkInfo[]
	): Promise<UploadJob[]> {

		const { chainManager, currentTask, config, progressManager } = context;

		if (!currentTask) {
			throw new Error('[AvailableAllocator] context.currentTask が設定されていません。');
		}

		// 1. 対象チェーンを決定
		const allDatachains = chainManager.getDatachainInfos();
		const chainCount = currentTask.chainCount ?? allDatachains.length;
		const targetDatachains = allDatachains.slice(0, chainCount);

		if (targetDatachains.length === 0) {
			throw new Error('[AvailableAllocator] 利用可能な datachain が0件です。');
		}

		// 2. プログレスバーとMempool監視クライアントを準備
		this.chainClients.clear();
		this.chainBars.clear();
		for (const chain of targetDatachains) {
			try {
				const client = await this.getTmClient(context, chain.name);
				this.chainClients.set(chain.name, client);
				const bar = progressManager.addBar(chain.name.padEnd(8), 0, 0, { status: 'Waiting...' });
				this.chainBars.set(chain.name, bar);
			} catch (error) {
				log.error(`[AvailableAllocator] Mempool監視クライアント (${chain.name}) の取得に失敗しました。`, error);
				throw error; // 割り当て失敗
			}
		}

		// 3. バッチサイズを決定 (OneByOne の場合は実質1)
		const batchSize = (config.strategies.upload === 'Sequential') // Sequential は OneByOneTransmitter を使う想定
			? 1
			: DEFAULT_BATCH_SIZE_PER_CHAIN; // TODO: options から取得

		const batches = this.coreLogic.createBatches(allChunks, batchSize);
		const batchQueue = [...batches];
		log.info(`[AvailableAllocator] ${allChunks.length} チャンク (${batches.length} バッチ) を ${targetDatachains.length} チェーンに動的割り当て開始...`);

		// 4. バッチキューによる動的割り当て
		const uploadJobs: UploadJob[] = [];
		const actualChunksAssigned = new Map<string, number>(); // バーのTotal更新用
		targetDatachains.forEach(c => actualChunksAssigned.set(c.name, 0));

		try {
			while (batchQueue.length > 0) {
				const availableChain = await this.findAvailableChain(this.chainClients, this.chainBars);

				if (!availableChain) {
					throw new Error('[AvailableAllocator] 空いているチェーンが見つかりませんでした (タイムアウト)。');
				}

				const availableChainName = availableChain.name;
				const bar = this.chainBars.get(availableChainName)!;
				const nextBatch = batchQueue.shift();
				if (!nextBatch) break; // キューが空になった

				// バーの最大値(Total)を動的に調整
				const currentAssigned = actualChunksAssigned.get(availableChainName) ?? 0;
				const newTotalAssigned = currentAssigned + nextBatch.chunks.length;
				actualChunksAssigned.set(availableChainName, newTotalAssigned);
				bar.setTotal(newTotalAssigned);
				bar.updatePayload({ status: 'Batch Assigned' });

				log.info(`[AvailableAllocator] バッチ ${batches.length - batchQueue.length}/${batches.length} を ${availableChainName} に割り当て`);

				// ジョブリストに追加
				uploadJobs.push({
					chainName: availableChainName,
					batch: nextBatch
				});
			}

			// 5. 割り当て完了
			log.info('[AvailableAllocator] 全バッチの割り当てが完了しました。');
			return uploadJobs;

		} catch (error) {
			log.error(`[AvailableAllocator] 割り当て処理ループ中にエラーが発生しました。`, error);
			this.cleanupBars(true, actualChunksAssigned); // エラー時はバーを 'Failed' に
			throw error; // 呼び出し元 (CompositeStrategy) にエラーを伝播
		} finally {
			// クリーンアップ処理は CompositeStrategy が実行完了した後 (finally) で行う
			// ここでは allocateChunks が完了しただけ
		}
	}

	/**
	 * 割り当て処理完了後 (成功または失敗時) にバーの後処理を行う
	 * (CompositeStrategy から呼び出されることを想定... だが責務が曖昧になる)
	 *
	 * → AvailableAllocator はバーの *割り当て* (setTotal, 'Batch Assigned') までを担当する。
	 * Transmitter が実行中のステータス ('Broadcasting', 'Confirming', 'Batch Done') を更新する。
	 * CompositeStrategy が全Job完了後に、バーの後処理 (cleanupBars) を行う。
	 */
	public cleanupBars(isError: boolean, actualChunksAssigned: Map<string, number>): void {
		this.chainBars.forEach((bar, name) => {
			const totalAssigned = actualChunksAssigned.get(name) ?? 0;

			if (isError) {
				if (bar.getTotal() > 0) bar.updatePayload({ status: 'Failed' });
				else bar.update(0, { status: 'Failed' });
			} else if (totalAssigned === 0) {
				// 正常終了だが、何も割り当てられなかった場合
				bar.setTotal(1);
				bar.update(1, { status: 'Done' });
			} else {
				// 正常終了 (Transmitter が 'Batch Done' にしているはず)
				bar.update(totalAssigned, { status: 'Done' });
			}
		});
	}

	// --- 内部ヘルパー (旧 DistributeUploadStrategy から) ---

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
					chainBars.get(name)?.updatePayload({ status: 'Mempool Error' });
					return { name, bytes: Infinity };
				}
			});

			const statuses = await Promise.all(checks);
			const bestChain = statuses.sort((a, b) => a.bytes - b.bytes)[0];

			if (bestChain && bestChain.bytes < MEMPOOL_BYTES_LIMIT) {
				log.debug(`[Mempool] 空きチェーン発見: ${bestChain.name} (Bytes: ${bestChain.bytes})`);
				chainBars.get(bestChain.name)?.updatePayload({
					status: 'Mempool Ready',
					dynamicInfo: ''
				});
				return { name: bestChain.name, type: 'datachain' };
			}

			statuses.forEach(status => {
				const bar = chainBars.get(status.name);
				if (!bar) return;
				// (実行中のバーのステータスを上書きしないよう、'Waiting' または 'Mempool' 関連のステータスの場合のみ更新するほうが望ましいが、簡易実装)
				if (status.bytes >= MEMPOOL_BYTES_LIMIT) {
					const bytesMB = (status.bytes / 1024 / 1024).toFixed(1);
					bar.updatePayload({
						status: 'Mempool Full',
						dynamicInfo: `(${bytesMB}MB)`
					});
					log.debug(`[Mempool] ${status.name} Mempool Full: ${bytesMB}MB`);
				} else {
					bar.updatePayload({ dynamicInfo: '' });
				}
			});

			log.debug(`[Mempool] 空きチェーンなし。待機中... (Min bytes: ${bestChain?.bytes ?? 'N/A'})`);
			await sleep(MEMPOOL_POLL_INTERVAL_MS);
		}
		return null; // タイムアウト
	}

	private async getTmClient(context: RunnerContext, chainName: string): Promise<CometClient> {
		const { communicationStrategy, infraService } = context;

		if (communicationStrategy.constructor.name !== 'WebSocketCommunicationStrategy') {
			throw new Error(`[AvailableAllocator] は WebSocketCommunicationStrategy が必要です (Mempool監視のため)。`);
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