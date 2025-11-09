// controller/src/strategies/upload/BaseOneByOneStrategy.ts
import { DeliverTxResponse } from '@cosmjs/stargate';
import { MsgCreateStoredChunk, RunnerContext } from '../../types/index';
import { log } from '../../utils/logger';
// ★ 修正: ChunkLocation をインポート
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
	 * 派生クラスは、スケジューリングロジック (distributeJobs) のみを実装します。
	 * ★ 修正: 戻り値を ChunkLocation[] | null に変更
	 */
	protected async processUpload(
		context: RunnerContext,
		allChunks: ChunkInfo[],
		estimatedGasLimit: string // この方式では 'auto' を使うため不要だが、I/F合わせ
	): Promise<ChunkLocation[] | null> {

		// 【抽象メソッド】派生クラス（具象戦略）がスケジューリングを実行
		// どのチェーンにどのチャンクを割り当てるかのリストを作成
		const jobs = this.distributeJobs(context, allChunks);

		// 逐次または並列で実行 (この基底クラスでは最もシンプルな逐次実行を実装)
		log.step(`[${this.constructor.name}] ${allChunks.length} チャンクをワンバイワン方式で逐次処理開始...`);

		const successfulLocations: ChunkLocation[] = []; // ★ 修正: 実績リスト

		for (let i = 0; i < jobs.length; i++) {
			const job = jobs[i]!;
			log.info(`[${this.constructor.name}] チャンク ${i + 1}/${jobs.length} (Index: ${job.chunk.index}) を ${job.chainName} に送信中...`);

			// ★ 修正: 戻り値 (実績) を受け取る
			const location = await this.processChunkOneByOne(context, job.chainName, job.chunk);

			if (location === null) {
				log.error(`[${this.constructor.name}] チャンク ${job.chunk.index} の処理に失敗。アップロードを中断します。`);
				return null; // ★ 修正: 失敗時は null を返す
			}

			successfulLocations.push(location); // ★ 修正: 成功した実績を追加
		}

		log.info(`[${this.constructor.name}] 全 ${jobs.length} チャンクの処理が完了しました。`);
		return successfulLocations; // ★ 修正: 成功した実績リストを返す
	}

	/**
	 * 【抽象メソッド】スケジューリングロジック。
	 * 派生クラスは、全チャンクをどのチェーンに割り当てるかのリストを作成します。
	 */
	protected abstract distributeJobs(
		context: RunnerContext,
		allChunks: ChunkInfo[]
	): { chainName: string, chunk: ChunkInfo }[];


	/**
	 * 1件のチャンクを「ワンバイワン」方式で送信・確認します。
	 * ★ 修正: 戻り値を ChunkLocation | null に変更
	 */
	protected async processChunkOneByOne(
		context: RunnerContext,
		chainName: string,
		chunk: ChunkInfo
	): Promise<ChunkLocation | null> { // ★ 修正: 戻り値の型

		const { chainManager, tracker } = context;
		const account = chainManager.getChainAccount(chainName);

		const msg: MsgCreateStoredChunk = {
			creator: account.address,
			index: chunk.index,
			data: chunk.chunk,
		};

		try {
			// 1件ずつ送信し、完了(DeliverTxResponse)を待つ
			const { gasUsed, transactionHash, height, code, rawLog }: DeliverTxResponse =
				await account.signingClient.signAndBroadcast(
					account.address,
					[{ typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk', value: msg }],
					'auto' // ガス代は自動計算
				);

			const success = code === 0;

			tracker.recordTransaction({
				hash: transactionHash,
				chainName: chainName,
				success: success,
				height: height,
				gasUsed: gasUsed,
				feeAmount: undefined, // 'auto' のため正確な手数料取得は困難
				error: success ? undefined : rawLog,
			});

			if (!success) {
				log.warn(`[OneByOne] Tx失敗 (Chain: ${chainName}, Hash: ${transactionHash}): ${rawLog}`);
				return null; // ★ 修正: 失敗時は null
			}

			// ★ 修正: 成功時は実績を返す
			return { index: chunk.index, chainName: chainName };

		} catch (error: any) {
			log.error(`[OneByOne] signAndBroadcast 中に例外発生 (Chain: ${chainName})。`, error);
			tracker.recordTransaction({
				hash: 'N/A (Broadcast Error)',
				chainName: chainName,
				success: false,
				error: error.message || 'Broadcast Error',
			});
			return null; // ★ 修正: 失敗時は null
		}
	}
}