// controller/src/strategies/upload/BaseOneByOneStrategy.ts
import { DeliverTxResponse } from '@cosmjs/stargate';
// ★ 修正: IProgressBar をインポート
import { IProgressBar } from '../../../utils/ProgressManager/IProgressManager';
// ★ 修正: ConfirmationResult をインポート
import { ConfirmationResult, MsgCreateStoredChunk, RunnerContext } from '../../../types/index';
import { log } from '../../../utils/logger';
import { BaseUploadStrategy, ChunkInfo, ChunkLocation } from './BaseUploadStrategy';

/**
 * 「ワンバイワン」方式（1 Tx ずつ signAndBroadcast）の共通ロジックを提供する抽象基底クラス。
 */
export abstract class BaseOneByOneStrategy extends BaseUploadStrategy {

	constructor() {
		super();
	}

	/**
	 * 【Template Method】ワンバイワン方式のアップロード処理を実行します。
	 * (★ 修正: プログレスバーの作成と、ログ削除)
	 */
	protected async processUpload(
		context: RunnerContext,
		allChunks: ChunkInfo[],
		estimatedGasLimit: string // この方式では未使用
	): Promise<ChunkLocation[] | null> {

		// ★ 修正: progressManager を context から取得
		const { progressManager } = context;

		const jobs = this.distributeJobs(context, allChunks);
		log.info(`[${this.constructor.name}] ${allChunks.length} チャンクをワンバイワン方式で逐次処理開始...`); // (ファイルログ用)

		const successfulLocations: ChunkLocation[] = [];

		// ★ プログレスバーを作成 (チェーンごとではなく、全ジョブで1本)
		const chainName = jobs[0]?.chainName ?? 'sequential';
		const totalChunks = allChunks.length;
		const bar = progressManager.addBar(chainName.padEnd(8), totalChunks, 0, { status: 'Uploading...' });

		for (let i = 0; i < jobs.length; i++) {
			const job = jobs[i]!;

			// ★ bar を渡す
			const location = await this.processChunkOneByOne(context, job.chainName, job.chunk, bar);

			if (location === null) {
				log.error(`[${this.constructor.name}] チャンク ${job.chunk.index} の処理に失敗。アップロードを中断します。`);
				// (bar のステータスは processChunkOneByOne 内で更新される)
				return null;
			}

			successfulLocations.push(location);
		}

		bar.updatePayload({ status: 'Done' }); // 完了ステータス
		return successfulLocations;
	}

	/**
	 * 【抽象メソッド】スケジューリングロジック。
	 */
	protected abstract distributeJobs(
		context: RunnerContext,
		allChunks: ChunkInfo[]
	): { chainName: string, chunk: ChunkInfo }[];


	/**
	 * 1件のチャンクを「ワンバイワン」方式で送信・確認します。
	 * (★ 修正: bar を引数に取り、進捗を更新)
	 */
	protected async processChunkOneByOne(
		context: RunnerContext,
		chainName: string,
		chunk: ChunkInfo,
		bar: IProgressBar // ★ 追加
	): Promise<ChunkLocation | null> {

		const { chainManager, tracker } = context;
		const account = chainManager.getChainAccount(chainName);

		const msg: MsgCreateStoredChunk = {
			creator: account.address,
			index: chunk.index,
			data: chunk.chunk,
		};

		let result: ConfirmationResult; // ★ 結果格納用

		try {
			// 1件ずつ送信し、完了(DeliverTxResponse)を待つ
			const { gasUsed, transactionHash, height, code, rawLog }: DeliverTxResponse =
				await account.signingClient.signAndBroadcast(
					account.address,
					[{ typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk', value: msg }],
					'auto' // ガス代は自動計算
				);

			const success = code === 0;

			result = {
				success: success,
				height: height,
				gasUsed: gasUsed,
				feeAmount: undefined, // 'auto' のため正確な手数料取得は困難
				error: success ? undefined : rawLog,
			};

			tracker.recordTransaction({
				hash: transactionHash,
				chainName: chainName,
				...result
			});

			if (!success) {
				log.warn(`[OneByOne] Tx失敗 (Chain: ${chainName}, Hash: ${transactionHash}): ${rawLog}`);
				// ★ バーの進捗は進めるが、ペイロードを更新
				bar.increment(1, { status: 'Tx Failed!'});
				return null;
			}

			// ★ 修正: 成功時はバーの進捗を更新
			bar.increment(1);
			return { index: chunk.index, chainName: chainName };

		} catch (error: any) {
			log.error(`[OneByOne] signAndBroadcast 中に例外発生 (Chain: ${chainName})。`, error);

			result = {
				success: false,
				error: error.message || 'Broadcast Error',
			};

			tracker.recordTransaction({
				hash: 'N/A (Broadcast Error)',
				chainName: chainName,
				...result
			});

			// ★ バーの進捗は進めるが、ペイロードを更新
			bar.increment(1, { status: 'Broadcast Error' });
			return null;
		}
	}
}