// controller/src/strategies/confirmation/PollingConfirmationStrategy.ts
import { decodeTxRaw } from '@cosmjs/proto-signing';
import { ConfirmationResult, RunnerContext } from '../../types';
import { log } from '../../utils/logger';
import { sleep } from '../../utils/retry';
import { ConfirmationOptions, IConfirmationStrategy } from './IConfirmationStrategy';

// ★ 修正: TxResponse と TxParams を 'tendermint34' からインポート
import { TxParams, TxResponse } from '@cosmjs/tendermint-rpc/build/tendermint34';
// (注: ライブラリの内部構造に依存するパスですが、ご提示いただいたエクスポートリストに基づき 'tendermint34' を使用します)

// ポーリング設定
const DEFAULT_POLLING_INTERVAL_MS = 1000;
const DEFAULT_POLLING_TIMEOUT_MS = 60000;

/**
 * Hex文字列をUint8Arrayに変換するヘルパー関数
 * (Txハッシュの変換に必要)
 */
function fromHex(hexString: string): Uint8Array {
	const normalized = hexString.startsWith('0x') ? hexString.slice(2) : hexString;
	if (normalized.length % 2 !== 0) {
		throw new Error('Invalid hex string length (must be even)');
	}
	return Uint8Array.from(Buffer.from(normalized, 'hex'));
}

/**
 * RPCエンドポイントへのポーリング（.tx() メソッド）によって、
 * トランザクションの完了を確認する戦略。
 */
export class PollingConfirmationStrategy implements IConfirmationStrategy {
	constructor() {
		log.debug('PollingConfirmationStrategy がインスタンス化されました。');
	}

	public async confirmTransactions(
		context: RunnerContext,
		chainName: string,
		txHashes: string[],
		options: ConfirmationOptions
	): Promise<Map<string, ConfirmationResult>> {

		const { communicationStrategy, infraService } = context;
		const timeout = options.timeoutMs ?? DEFAULT_POLLING_TIMEOUT_MS;
		const startTime = Date.now();

		log.info(`[PollingConfirm] チェーン "${chainName}" で ${txHashes.length} 件のTxをポーリング確認開始 (Timeout: ${timeout}ms)`);

		// 1. RPCエンドポイントを取得
		const rpcEndpoints = await infraService.getRpcEndpoints();
		const rpcEndpoint = rpcEndpoints[chainName];
		if (!rpcEndpoint) {
			throw new Error(`[PollingConfirm] チェーン "${chainName}" のRPCエンドポイントが見つかりません。`);
		}

		// 2. RPCクライアントを 通信戦略 から取得
		const tmClient = communicationStrategy.getRpcClient(rpcEndpoint);

		// 3. ★ 修正: tmClient の存在と 'tx' メソッドの存在をチェック (型ガード)
		if (!tmClient || !('tx' in tmClient)) {
			throw new Error(`[PollingConfirm] チェーン "${chainName}" (Endpoint: ${rpcEndpoint}) の通信クライアントが 'tx' メソッドをサポートしていません。`);
		}
		// この時点で tmClient は .tx() を持つ (Tendermint37Client | Comet38Client)

		const pendingHashes = new Set<string>(txHashes);
		const results = new Map<string, ConfirmationResult>();

		// 4. タイムアウトまでポーリングをループ
		while (Date.now() - startTime < timeout) {
			if (pendingHashes.size === 0) {
				log.debug(`[PollingConfirm] ${txHashes.length} 件すべてのTx確認が完了しました。`);
				break;
			}

			log.debug(`[PollingConfirm] 残り ${pendingHashes.size} 件のTxをポーリング中...`);

			const checks = Array.from(pendingHashes).map(async (hash) => {
				try {
					// ★ 修正: tmClient.tx() を使用。ハッシュを Uint8Array に変換
					const hashBytes = fromHex(hash);
					const txParams: TxParams = { hash: hashBytes, prove: false }; // prove は不要

					// tx() は TxResponse を返す (null は返さない。見つからない場合はエラーをスローする)
					const txInfo: TxResponse = await tmClient.tx(txParams) as TxResponse;

					// Txが見つかった
					pendingHashes.delete(hash);

					const result: ConfirmationResult = {
						// ★ 修正: TxResponse の構造 (tx_result) に合わせる
						success: txInfo.result.code === 0,
						height: txInfo.height,
						gasUsed: BigInt(txInfo.result.gasUsed ?? 0),
						feeAmount: this.extractFee(txInfo), // 手数料を txInfo から抽出
						error: txInfo.result.code !== 0 ? txInfo.result.log : undefined,
					};
					results.set(hash, result);

					log.debug(`[PollingConfirm] Tx確認完了 (Hash: ${hash.substring(0, 10)}..., Success: ${result.success})`);
					options.onProgress?.(results.size, txHashes.length);

				} catch (error: any) {
					// ★ 修正: "not found" エラーはポーリング継続対象、それ以外は警告
					const errorMessage = String(error.message || error);
					if (errorMessage.includes('not found') || errorMessage.includes('not in mempool')) {
						// Txがまだ見つからない (ポーリング継続)
						log.debug(`[PollingConfirm] Tx ${hash.substring(0, 10)}... はまだ見つかりません。`);
					} else {
						// 永続的なエラーの可能性 (例: RPCノードダウン)
						log.warn(`[PollingConfirm] tx(${hash}) 実行中に予期せぬエラーが発生しました。`, error);
					}
				}
			});

			await Promise.allSettled(checks);

			if (pendingHashes.size > 0) {
				await sleep(DEFAULT_POLLING_INTERVAL_MS);
			}
		} // while ループ終了

		// 5. タイムアウト処理
		if (pendingHashes.size > 0) {
			log.warn(`[PollingConfirm] タイムアウト (${timeout}ms) しました。 ${pendingHashes.size} 件のTxが未確認です。`);
			for (const hash of pendingHashes) {
				results.set(hash, {
					success: false,
					error: '確認タイムアウト',
					height: undefined,
					gasUsed: undefined,
					feeAmount: undefined,
				});
			}
		}

		log.info(`[PollingConfirm] ポーリング確認終了。 (成功: ${Array.from(results.values()).filter(r => r.success).length}, 失敗: ${Array.from(results.values()).filter(r => !r.success).length})`);

		return results;
	}

	/**
	 * TxResponse から手数料 (feeAmount) を抽出するヘルパー関数
	 * ★ 修正: 引数の型を TxResponse に変更
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