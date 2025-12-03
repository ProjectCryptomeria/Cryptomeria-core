// controller/src/strategies/confirmation/PollingConfirmationStrategy.ts
import { decodeTxRaw } from '@cosmjs/proto-signing';
import { ConfirmationResult, RunnerContext } from '../../types';
import { log } from '../../utils/logger';
import { sleep } from '../../utils/retry';
import { ConfirmationOptions } from './IConfirmationStrategy';
// ★ 修正: TxParams と TxResponse のインポートパス
import { TxParams, TxResponse } from '@cosmjs/tendermint-rpc/build/tendermint34';
// ★ 修正: BaseConfirmationStrategy をインポート
import { BaseConfirmationStrategy } from './BaseConfirmationStrategy';

const DEFAULT_POLLING_INTERVAL_MS = 1000;

/**
 * Hex文字列をUint8Arrayに変換するヘルパー関数
 */
function fromHex(hexString: string): Uint8Array {
	const normalized = hexString.startsWith('0x') ? hexString.slice(2) : hexString;
	if (normalized.length % 2 !== 0) {
		throw new Error('Invalid hex string length (must be even)');
	}
	return Uint8Array.from(Buffer.from(normalized, 'hex'));
}

/**
 * RPCエンドポイントへのポーリングによって完了を確認する戦略。
 * (★ BaseConfirmationStrategy を継承)
 */
export class PollingConfirmationStrategy extends BaseConfirmationStrategy {

	private active = true; // ポーリングループ停止用フラグ

	constructor() {
		super(); // ★ 基底クラスのコンストラクタ
		log.debug('PollingConfirmationStrategy がインスタンス化されました。');
	}

	/**
	 * 【実装】ポーリングループを開始します。
	 * ★ 修正: onProgress の呼び出し
	 */
	protected async _startConfirmationProcess(
		context: RunnerContext,
		chainName: string,
		pendingHashes: Set<string>,
		results: Map<string, ConfirmationResult>,
		options: ConfirmationOptions,
		totalTxCount: number
	): Promise<void> {

		const { communicationStrategy, infraService } = context;
		this.active = true;

		// 1. RPCクライアントを取得
		const rpcEndpoints = await infraService.getRpcEndpoints();
		const rpcEndpoint = rpcEndpoints[chainName];
		if (!rpcEndpoint) {
			throw new Error(`[PollingConfirm] チェーン "${chainName}" のRPCエンドポイントが見つかりません。`);
		}
		const tmClient = communicationStrategy.getRpcClient(rpcEndpoint);
		if (!tmClient || !('tx' in tmClient)) {
			throw new Error(`[PollingConfirm] チェーン "${chainName}" (Endpoint: ${rpcEndpoint}) の通信クライアントが 'tx' メソッドをサポートしていません。`);
		}

		// 2. ポーリングループ (基底クラスのタイムアウトに任せる)
		while (this.active && pendingHashes.size > 0) {
			log.debug(`[PollingConfirm] 残り ${pendingHashes.size} 件のTxをポーリング中...`);

			const checks = Array.from(pendingHashes).map(async (hash) => {
				try {
					const hashBytes = fromHex(hash);
					const txParams: TxParams = { hash: hashBytes, prove: false };
					const txInfo: TxResponse = await tmClient.tx(txParams) as TxResponse;

					// Txが見つかった
					pendingHashes.delete(hash);

					const result: ConfirmationResult = {
						success: txInfo.result.code === 0,
						height: txInfo.height,
						gasUsed: BigInt(txInfo.result.gasUsed ?? 0),
						feeAmount: this.extractFee(txInfo),
						error: txInfo.result.code !== 0 ? txInfo.result.log : undefined,
					};
					results.set(hash, result);

					log.debug(`[PollingConfirm] Tx確認完了 (Hash: ${hash.substring(0, 10)}..., Success: ${result.success})`);

					// ★ 修正: 完了した result を onProgress に渡す
					options.onProgress?.(result);

				} catch (error: any) {
					const errorMessage = String(error.message || error);
					if (errorMessage.includes('not found') || errorMessage.includes('not in mempool')) {
						log.debug(`[PollingConfirm] Tx ${hash.substring(0, 10)}... はまだ見つかりません。`);
					} else {
						log.warn(`[PollingConfirm] tx(${hash}) 実行中に予期せぬエラーが発生しました。`, error);
					}
				}
			});

			await Promise.allSettled(checks);

			if (pendingHashes.size > 0) {
				await sleep(DEFAULT_POLLING_INTERVAL_MS);
			}
		}
	}

	/**
	 * 【実装】ポーリングループを停止します。
	 */
	protected _cleanup(context: RunnerContext, chainName: string): void {
		log.debug(`[PollingConfirm] クリーンアップ: ポーリングループを停止します。`);
		this.active = false;
	}

	/**
	 * TxResponse から手数料 (feeAmount) を抽出するヘルパー関数
	 */
	private extractFee(txInfo: TxResponse): bigint {
		try {
			const txRawBytes: Uint8Array = txInfo.tx;
			if (!txRawBytes) {
				log.warn(`[PollingConfirm] TxResponse.tx が Uint8Array ではありません。手数料を 0n とします。`);
				return 0n;
			}
			const txRaw = decodeTxRaw(txRawBytes);
			const fee = txRaw.authInfo?.fee;
			if (fee && fee.amount.length > 0) {
				const feeAmount = fee.amount[0]?.amount;
				if (feeAmount) {
					return BigInt(feeAmount);
				}
			}
			return 0n;
		} catch (error) {
			log.warn(`[PollingConfirm] TxResponse からの手数料抽出に失敗しました。`, error);
			return 0n;
		}
	}
}