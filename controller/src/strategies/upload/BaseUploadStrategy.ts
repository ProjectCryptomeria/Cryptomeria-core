// controller/src/strategies/upload/BaseUploadStrategy.ts
import { sha256 } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import { EncodeObject } from '@cosmjs/proto-signing';
import { DeliverTxResponse } from '@cosmjs/stargate';
import {
	// ★ 修正: ChunkLocationTuple をインポート
	ChunkLocationTuple,
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

// ★ 修正: アップロード実績（中間形式）
export interface ChunkLocation {
	index: string;
	chainName: string;
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

		// ★★★ 2. チャンク化 (変更点) ★★★
		// config.uploadStrategyOptions ではなく context.currentTask から chunkSize を取得
		const task = context.currentTask;
		if (!task) {
			throw new Error('BaseUploadStrategy.execute: context.currentTask が設定されていません。');
		}

		const chunkSize = task.chunkSize === 'auto' || !task.chunkSize ? DEFAULT_CHUNK_SIZE : task.chunkSize;
		tracker.setChunkSizeUsed(chunkSize);
		const allChunks = this.createChunks(data, chunkSize);
		log.info(`[${this.constructor.name}] データは ${allChunks.length} 個のチャンクに分割されました。`);
		// ★★★ 変更点 (ここまで) ★★★

		if (allChunks.length === 0) {
			log.warn(`[${this.constructor.name}] チャンクが0個です。マニフェストのみ登録します。`);
		}

		// 3. ガス見積もり (共通)
		let estimatedGasLimit = FALLBACK_GAS_LIMIT;
		if (allChunks.length > 0) {
			estimatedGasLimit = await this.estimateGas(context, allChunks[0]!);
		}

		// 4. 【抽象メソッド】チャンクのアップロード処理 (戦略固有)
		// ★ 修正: 戻り値を boolean から ChunkLocation[] | null に変更
		let chunkLocations: ChunkLocation[] | null = null;
		if (allChunks.length > 0) {
			chunkLocations = await this.processUpload(
				context,
				allChunks,
				estimatedGasLimit
			);
		} else {
			chunkLocations = []; // チャンクが0件の場合は空のリスト
		}

		// 5. マニフェスト登録 (共通)
		// ★ 修正: chunkLocations が null (失敗) の場合はスキップ
		if (chunkLocations === null) {
			log.error(`[${this.constructor.name}] チャンクのアップロードに失敗しました。マニフェスト登録をスキップします。`);
		} else {
			// --- ★ ログレベル変更 (step -> info) ---
			log.info(`[${this.constructor.name}] 全チャンクのアップロード完了。マニフェストを登録中...`);
			try {
				// ★ 修正: 実績リスト (chunkLocations) を渡す
				await this.registerManifest(context, urlParts, chunkLocations);
			} catch (error) {
				log.error(`[${this.constructor.name}] マニフェストの登録に失敗しました。`, error);
			}
		}

		// 6. 最終結果 (共通)
		tracker.markUploadEnd();
		const result = tracker.getUploadResult();
		// --- ★ ログレベル変更 (info -> success) ---
		log.success(`[${this.constructor.name}] 完了。所要時間: ${result.durationMs} ms`);
		return result;
	}

	/**
	 * 【抽象メソッド】戦略固有のアップロードロジック。
	 * 派生クラス（BaseOneByOne / BaseMultiBurst）は、このメソッドを実装し、
	 * チャンクリストをどのように送信・確認するかを定義します。
	 * @param context 実行コンテキスト
	 * @param allChunks 処理対象の全チャンクのリスト
	 * @param estimatedGasLimit 1 Tx あたりのガスリミット (マルチバースト用)
	 * @returns 成功した場合は { index, chainName } のリスト、失敗した場合は null
	 */
	protected abstract processUpload(
		context: RunnerContext,
		allChunks: ChunkInfo[],
		estimatedGasLimit: string
	): Promise<ChunkLocation[] | null>; // ★ 修正: 戻り値の型


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
	 * ★ 修正: 圧縮マニフェストを構築するロジックに変更
	 */
	protected async registerManifest(
		context: RunnerContext,
		urlParts: UrlParts,
		chunkLocations: ChunkLocation[] // ★ 修正: 中間形式 { index, chainName }[] を受け取る
	): Promise<void> {
		const { chainManager, tracker } = context;
		const metachain = chainManager.getMetachainInfo();
		const metachainAccount = chainManager.getChainAccount(metachain.name);

		// --- 圧縮マニフェスト構築ロジック ---
		const chainMap: { [chainName: string]: number } = {};
		let chainIndexCounter = 0;
		const locationTuples: ChunkLocationTuple[] = [];

		for (const loc of chunkLocations) {
			if (chainMap[loc.chainName] === undefined) {
				chainMap[loc.chainName] = chainIndexCounter++;
			}
			const chainMapIndex = chainMap[loc.chainName]!;
			locationTuples.push([loc.index, chainMapIndex]);
		}

		const manifest: Manifest = {
			chainMap: chainMap,
			files: {
				[urlParts.filePathEncoded]: locationTuples, // エンコード済みのパスをキーにする
			}
		};
		// --- ここまで ---

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

		// --- ★ ログレベル変更 (info -> success) ---
		log.success(`[${this.constructor.name}] マニフェスト登録成功 (BaseURL: ${urlParts.baseUrlRaw})。TxHash: ${transactionHash}`);
		log.debug(`[${this.constructor.name}] 登録Manifest (圧縮): ${manifestContent}`);

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