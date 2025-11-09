// controller/src/strategies/upload/BaseUploadStrategy.ts
import { sha256 } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import { EncodeObject } from '@cosmjs/proto-signing';
import { DeliverTxResponse } from '@cosmjs/stargate';
import {
	Manifest,
	MsgCreateStoredChunk,
	MsgCreateStoredManifest,
	RunnerContext,
	UploadResult,
	UrlParts,
} from '../../types/index';
import { log } from '../../utils/logger';
import { IUploadStrategy } from './IUploadStrategy';

// デフォルト値
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const FALLBACK_GAS_LIMIT = '60000000';

/**
 * チャンクとインデックスのペア
 */
export interface ChunkInfo {
	index: string;
	chunk: Buffer;
}

/**
 * チャンクのバッチ
 */
export interface ChunkBatch {
	chunks: ChunkInfo[];
}

/**
 * アップロード戦略の「方式を問わない」共通処理を実装する最上位の抽象基底クラス。
 * チャンク化、ガス見積もり、マニフェスト登録、executeの骨格を提供する。
 */
export abstract class BaseUploadStrategy implements IUploadStrategy {

	/**
	 * 【Template Method】アップロード処理の共通フローを実行します。
	 * 派生クラスは、送信ロジック (processUpload) のみを実装します。
	 */
	public async execute(
		context: RunnerContext,
		data: Buffer,
		targetUrl: string
	): Promise<UploadResult> {
		const { tracker, config } = context;
		tracker.markUploadStart();
		log.info(`[${this.constructor.name}] 開始... URL (Raw): ${targetUrl}, データサイズ: ${data.length} bytes`);

		// 1. URL解析 (共通)
		const urlParts = context.urlPathCodec.parseTargetUrl(targetUrl);

		// 2. チャンク化 (共通)
		const options = config.uploadStrategyOptions ?? {};
		const chunkSize = options.chunkSize === 'auto' || !options.chunkSize ? DEFAULT_CHUNK_SIZE : options.chunkSize;
		tracker.setChunkSizeUsed(chunkSize);
		const allChunks = this.createChunks(data, chunkSize);
		log.info(`[${this.constructor.name}] データは ${allChunks.length} 個のチャンクに分割されました。`);

		if (allChunks.length === 0) {
			log.warn(`[${this.constructor.name}] チャンクが0個です。マニフェストのみ登録します。`);
		}

		// 3. ガス見積もり (共通)
		let estimatedGasLimit = FALLBACK_GAS_LIMIT;
		if (allChunks.length > 0) {
			estimatedGasLimit = await this.estimateGas(context, allChunks[0]!);
		}

		// 4. 【抽象メソッド】チャンクのアップロード処理 (戦略固有)
		let totalSuccess = true;
		if (allChunks.length > 0) {
			totalSuccess = await this.processUpload(
				context,
				allChunks,
				estimatedGasLimit
			);
		}

		// 5. マニフェスト登録 (共通)
		if (!totalSuccess) {
			log.error(`[${this.constructor.name}] チャンクのアップロードに失敗しました。マニフェスト登録をスキップします。`);
		} else {
			log.step(`[${this.constructor.name}] 全チャンクのアップロード完了。マニフェストを登録中...`);
			try {
				const chunkIndexes = allChunks.map(c => c.index);
				await this.registerManifest(context, urlParts, chunkIndexes);
			} catch (error) {
				log.error(`[${this.constructor.name}] マニフェストの登録に失敗しました。`, error);
			}
		}

		// 6. 最終結果 (共通)
		tracker.markUploadEnd();
		const result = tracker.getUploadResult();
		log.info(`[${this.constructor.name}] 完了。所要時間: ${result.durationMs} ms`);
		return result;
	}

	/**
	 * 【抽象メソッド】戦略固有のアップロードロジック。
	 * 派生クラス（BaseOneByOne / BaseMultiBurst）は、このメソッドを実装し、
	 * チャンクリストをどのように送信・確認するかを定義します。
	 * @param context 実行コンテキスト
	 * @param allChunks 処理対象の全チャンクのリスト
	 * @param estimatedGasLimit 1 Tx あたりのガスリミット (マルチバースト用)
	 * @returns すべての処理が成功したか
	 */
	protected abstract processUpload(
		context: RunnerContext,
		allChunks: ChunkInfo[],
		estimatedGasLimit: string
	): Promise<boolean>;


	// --- 以下、共通ヘルパーメソッド ---

	/**
	 * データをチャンク化します (共通)
	 */
	protected createChunks(data: Buffer, chunkSize: number): ChunkInfo[] {
		const fileHash = toHex(sha256(data)).toLowerCase();
		const chunks: ChunkInfo[] = [];
		for (let i = 0; i < data.length; i += chunkSize) {
			const chunk = data.subarray(i, i + chunkSize);
			chunks.push({
				index: `${fileHash}-${chunks.length}`, // 0始まりのインデックス
				chunk: chunk,
			});
		}
		return chunks;
	}

	/**
	 * チャンクをバッチ化します (共通ヘルパー)
	 */
	protected createBatches(chunks: ChunkInfo[], batchSize: number): ChunkBatch[] {
		const batches: ChunkBatch[] = [];
		for (let i = 0; i < chunks.length; i += batchSize) {
			batches.push({
				chunks: chunks.slice(i, i + batchSize),
			});
		}
		return batches;
	}

	/**
	 * ガスを見積もります (共通)
	 */
	protected async estimateGas(context: RunnerContext, sampleChunk: ChunkInfo): Promise<string> {
		const { gasEstimationStrategy, chainManager } = context;
		// 最初の datachain でシミュレーション
		const targetChainNameForSim = chainManager.getDatachainInfos()[0]?.name;
		if (!targetChainNameForSim) {
			log.warn('[GasSim] シミュレーション対象の datachain が見つかりません。フォールバックを使用します。');
			return FALLBACK_GAS_LIMIT;
		}

		const sampleMsg: EncodeObject = {
			typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk',
			value: {
				creator: chainManager.getAddress(targetChainNameForSim),
				index: sampleChunk.index,
				data: sampleChunk.chunk,
			} as MsgCreateStoredChunk
		};
		return gasEstimationStrategy.estimateGasLimit(
			context,
			targetChainNameForSim,
			sampleMsg
		);
	}

	/**
	 * マニフェストを metachain に登録します (共通)
	 */
	protected async registerManifest(
		context: RunnerContext,
		urlParts: UrlParts,
		chunkIndexes: string[]
	): Promise<void> {
		const { chainManager, tracker } = context;
		const metachain = chainManager.getMetachainInfo();
		const metachainAccount = chainManager.getChainAccount(metachain.name);

		const manifest: Manifest = {
			[urlParts.filePathEncoded]: chunkIndexes, // エンコード済みのパスをキーにする
		};
		const manifestContent = JSON.stringify(manifest);

		const msg: MsgCreateStoredManifest = {
			creator: metachainAccount.address,
			index: urlParts.baseUrlEncoded, // エンコード済みのベース URL
			domain: urlParts.baseUrlRaw,
			manifest: manifestContent,
		};

		const { gasUsed, transactionHash, height }: DeliverTxResponse =
			await metachainAccount.signingClient.signAndBroadcast(
				metachainAccount.address,
				[{ typeUrl: '/metachain.metastore.v1.MsgCreateStoredManifest', value: msg }],
				'auto'
			);

		log.info(`[${this.constructor.name}] マニフェスト登録成功 (BaseURL: ${urlParts.baseUrlRaw})。TxHash: ${transactionHash}`);

		tracker.recordTransaction({
			hash: transactionHash,
			chainName: metachain.name,
			success: true,
			height: height,
			gasUsed: gasUsed,
			feeAmount: undefined, // 'auto' のためfeeAmountの取得は困難
		});
		tracker.setManifestUrl(urlParts.original);
	}
}