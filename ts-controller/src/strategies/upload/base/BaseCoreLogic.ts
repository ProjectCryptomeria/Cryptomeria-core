// controller/src/strategies/upload/base/BaseCoreLogic.ts
import { sha256 } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import { EncodeObject } from '@cosmjs/proto-signing';
import { DeliverTxResponse } from '@cosmjs/stargate';
import {
	ChunkLocationTuple,
	Manifest,
	MsgCreateStoredChunk,
	MsgCreateStoredManifest,
	RunnerContext,
	UrlParts,
} from '../../../types/index';
import { log } from '../../../utils/logger';

const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const FALLBACK_GAS_LIMIT = '60000000';

// --- 型定義 (モジュール内で共通利用) ---

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
 * チャンクのアップロード実績（中間形式）
 */
export interface ChunkLocation {
	index: string;
	chainName: string;
}

/**
 * チャンクアロケーターが生成する「実行計画」
 */
export interface UploadJob {
	chainName: string;
	batch: ChunkBatch;
}

/**
 * アップロード戦略の「方式を問わない」共通処理を実装するヘルパークラス。
 * (旧 BaseUploadStrategy)
 * チャンク化、ガス見積もり、マニフェスト登録のロジックを提供します。
 */
export class BaseCoreLogic {

	constructor() {
		log.debug('BaseCoreLogic がインスタンス化されました。');
	}

	/**
	 * データをチャンク化します (共通)
	 * (★ 修正: context.currentTask を引数で受け取る)
	 */
	public createChunks(data: Buffer, context: RunnerContext): { chunks: ChunkInfo[], chunkSizeUsed: number } {
		const task = context.currentTask;
		if (!task) {
			throw new Error('BaseCoreLogic.createChunks: context.currentTask が設定されていません。');
		}

		const chunkSize = task.chunkSize === 'auto' || !task.chunkSize ? DEFAULT_CHUNK_SIZE : task.chunkSize;

		const fileHash = toHex(sha256(data)).toLowerCase();
		const chunks: ChunkInfo[] = [];
		for (let i = 0; i < data.length; i += chunkSize) {
			const chunk = data.subarray(i, i + chunkSize);
			chunks.push({
				index: `${fileHash}-${chunks.length}`, // 0始まりのインデックス
				chunk: chunk,
			});
		}
		return { chunks, chunkSizeUsed: chunkSize };
	}

	/**
	 * チャンクをバッチ化します (共通ヘルパー)
	 */
	public createBatches(chunks: ChunkInfo[], batchSize: number): ChunkBatch[] {
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
	public async estimateGas(context: RunnerContext, sampleChunk: ChunkInfo): Promise<string> {
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
	public async registerManifest(
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

		log.debug(`[BaseCoreLogic] 登録Manifest (圧縮): ${manifestContent}`);

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