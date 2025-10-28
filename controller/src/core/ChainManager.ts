// controller/src/core/ChainManager.ts
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import {
	Account,
	GasPrice,
	SigningStargateClient,
	SigningStargateClientOptions,
	StargateClient,
	StargateClientOptions,
} from '@cosmjs/stargate';
import {
	CometClient
} from '@cosmjs/tendermint-rpc';
import { InfrastructureService } from '../infrastructure/InfrastructureService';
import { customRegistry } from '../registry';
import { ICommunicationStrategy } from '../strategies/communication/ICommunicationStrategy'; // ★ 修正: インターフェースのパス
import { ChainInfo, ChainType } from '../types';
import { log } from '../utils/logger';

const DEFAULT_GAS_PRICE = '0.0025stake';

interface ChainAccount {
	chainName: string;
	chainInfo: ChainInfo;
	wallet: DirectSecp256k1HdWallet;
	address: string;
	signingClient: SigningStargateClient;
	queryClient: StargateClient;
	accountNumber: number;
	sequence: number;
}

/**
 * 複数のチェーンへの接続、ウォレット、アカウントシーケンスを管理するクラス。
 */
export class ChainManager {
	private infraService!: InfrastructureService;
	private commStrategy!: ICommunicationStrategy;

	private chainInfos: ChainInfo[] = [];
	private accounts = new Map<string, ChainAccount>();
	private initialized = false;

	constructor() { }

	/**
	 * ChainManager を初期化します。
	 */
	public async init(
		infraService: InfrastructureService,
		commStrategy: ICommunicationStrategy
	): Promise<void> {
		if (this.initialized) {
			log.warn('ChainManager は既に初期化されています。');
			return;
		}

		log.step('ChainManager 初期化開始...');
		this.infraService = infraService;
		this.commStrategy = commStrategy;

		try {
			this.chainInfos = await this.infraService.getChainInfo();
			log.info(`検出されたチェーン (${this.chainInfos.length}件): ${this.chainInfos.map(c => c.name).join(', ')}`);

			const rpcEndpoints = await this.infraService.getRpcEndpoints();

			for (const chainInfo of this.chainInfos) {
				const { name } = chainInfo;
				const rpcEndpoint = rpcEndpoints[name];
				if (!rpcEndpoint) {
					throw new Error(`チェーン "${name}" のRPCエンドポイントが見つかりません。`);
				}

				const mnemonic = await this.infraService.getCreatorMnemonic(name);

				const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: 'cosmos' });
				const [firstAccount] = await wallet.getAccounts();

				// ★ 修正 (Error 1): firstAccount の存在チェック
				if (!firstAccount) {
					throw new Error(`[${name}] ウォレットからアカウントが取得できませんでした。`);
				}
				const address = firstAccount.address;
				log.info(`チェーン "${name}": ウォレット作成完了。アドレス: ${address}`);

				// ★ 修正: commStrategy.connect を呼び出し、getRpcClient でクライアント取得
				await this.commStrategy.connect(rpcEndpoint);
				const tendermintClient = this.commStrategy.getRpcClient(rpcEndpoint);

				if (!tendermintClient) {
					throw new Error(`[${name}] ICommunicationStrategy から RPCクライアントの取得に失敗しました (Endpoint: ${rpcEndpoint})。`);
				}

				const clientOptions: SigningStargateClientOptions = {
					registry: customRegistry,
					gasPrice: GasPrice.fromString(DEFAULT_GAS_PRICE),
				};

				// tendermintClient の型が (TendermintClient | HttpBatchClient) と広いため、
				// createWithSigner が要求する TendermintClient にキャスト (実行時チェックが望ましい)
				const signingClient = SigningStargateClient.createWithSigner(
					tendermintClient as CometClient, // ★ 修正: キャスト (WebSocket前提の場合)
					wallet,
					clientOptions
				);

				const queryClient = StargateClient.create(
					tendermintClient as CometClient, // ★ 修正: キャスト (WebSocket前提の場合)
					clientOptions as StargateClientOptions
				);

				log.info(`チェーン "${name}": SigningStargateClient 接続完了。`);

				const account = await this.fetchAccount(queryClient, address, name);

				this.accounts.set(name, {
					chainName: name,
					chainInfo: chainInfo,
					wallet: wallet,
					address: address,
					signingClient: signingClient,
					queryClient: queryClient,
					accountNumber: account.accountNumber,
					sequence: account.sequence,
				});
			}

			this.initialized = true;
			log.step('ChainManager 初期化完了。');

		} catch (error) {
			log.error('ChainManager の初期化に失敗しました。', error);
			throw error;
		}
	}

	/**
	 * アカウント情報をチェーンから取得します (リトライ付き)
	 * (変更なし)
	 */
	private async fetchAccount(client: StargateClient, address: string, chainName: string): Promise<Account> {
		const maxRetries = 5;
		for (let i = 0; i < maxRetries; i++) {
			try {
				const account = await client.getAccount(address);
				if (!account) {
					throw new Error('アカウントが見つかりません (null)。');
				}
				log.debug(`[${chainName}] アカウント情報取得 (試行 ${i + 1}): AccNum: ${account.accountNumber}, Seq: ${account.sequence}`);
				return account;
			} catch (error: any) { // ★ 修正: error: any
				log.warn(`[${chainName}] アカウント情報の取得に失敗 (試行 ${i + 1}/${maxRetries})。 1秒後にリトライ...`, error?.message || error);
				if (i < maxRetries - 1) {
					await new Promise(resolve => setTimeout(resolve, 1000));
				} else {
					log.error(`[${chainName}] アカウント情報の取得に ${maxRetries} 回失敗しました。`);
					throw error;
				}
			}
		}
		throw new Error(`[${chainName}] アカウント情報の取得に失敗しました (リトライ上限)。`);
	}

	/**
	 * 初期化が完了しているか確認します。
	 * (変更なし)
	 */
	private assertInitialized(): void {
		if (!this.initialized) {
			throw new Error('ChainManager が初期化されていません。先に init() を呼び出してください。');
		}
	}

	// --- ゲッターメソッド ---
	// (変更なし)
	public getChainAccount(chainName: string): ChainAccount {
		this.assertInitialized();
		const account = this.accounts.get(chainName);
		if (!account) {
			throw new Error(`チェーン "${chainName}" のアカウント情報が見つかりません。`);
		}
		return account;
	}
	public getSigningClient(chainName: string): SigningStargateClient {
		return this.getChainAccount(chainName).signingClient;
	}
	public getQueryClient(chainName: string): StargateClient {
		return this.getChainAccount(chainName).queryClient;
	}
	public getAddress(chainName: string): string {
		return this.getChainAccount(chainName).address;
	}
	public getWallet(chainName: string): DirectSecp256k1HdWallet {
		return this.getChainAccount(chainName).wallet;
	}
	public getChainInfos(type?: ChainType): ChainInfo[] {
		this.assertInitialized();
		if (!type) {
			return this.chainInfos;
		}
		return this.chainInfos.filter(info => info.type === type);
	}

	public getMetachainInfo(): ChainInfo {
		const metachains = this.getChainInfos('metachain');
		if (metachains.length === 0) {
			throw new Error('metachain が見つかりません。');
		}
		if (metachains.length > 1) {
			// ★ 修正 (Error 3): 非nullアサーション (!) を追加
			log.warn(`複数の metachain が検出されました。最初のもの (${metachains[0]!.name}) を使用します。`);
		}
		// ★ 修正 (Error 3): 非nullアサーション (!) を追加
		return metachains[0]!;
	}

	public getDatachainInfos(): ChainInfo[] {
		return this.getChainInfos('datachain');
	}

	// --- シーケンス番号管理 ---
	// (変更なし)
	public getCurrentSequence(chainName: string): number {
		return this.getChainAccount(chainName).sequence;
	}
	public getAccountNumber(chainName: string): number {
		return this.getChainAccount(chainName).accountNumber;
	}
	public incrementSequence(chainName: string, count: number = 1): number {
		const account = this.getChainAccount(chainName);
		const currentSeq = account.sequence;
		account.sequence += count;
		log.debug(`[${chainName}] シーケンス番号をインクリメント: ${currentSeq} -> ${account.sequence}`);
		return account.sequence;
	}
	public async resyncSequence(chainName: string): Promise<number> {
		log.warn(`[${chainName}] シーケンス番号をチェーンと再同期します...`);
		const account = this.getChainAccount(chainName);
		const onChainAccount = await this.fetchAccount(account.queryClient, account.address, chainName);

		if (onChainAccount.sequence > account.sequence) {
			log.warn(`[${chainName}] チェーン側のシーケンス (${onChainAccount.sequence}) がローカル (${account.sequence}) より進んでいます。ローカルを更新します。`);
			account.sequence = onChainAccount.sequence;
		} else if (onChainAccount.sequence < account.sequence) {
			log.warn(`[${chainName}] ローカルのシーケンス (${account.sequence}) がチェーン側 (${onChainAccount.sequence}) より進んでいます。ローカルの値 (${account.sequence}) を維持します。`);
		} else {
			log.info(`[${chainName}] シーケンス番号は同期済みです: ${account.sequence}`);
		}

		account.accountNumber = onChainAccount.accountNumber;
		return account.sequence;
	}

	/**
	 * すべての接続を切断します。
	 * ★ 修正 (Error 2): commStrategy.disconnect() をループの外で1回だけ呼び出す
	 */
	public async disconnectAll(): Promise<void> {
		if (!this.initialized) return;
		log.info('すべてのチェーン接続を切断しています...');

		for (const [name, account] of this.accounts.entries()) {
			try {
				account.signingClient.disconnect();
				account.queryClient.disconnect();
				log.debug(`[${name}] StargateClient 接続を切断しました。`);
			} catch (error) {
				log.warn(`[${name}] の切断中にエラーが発生しました。`, error);
			}
		}

		// ★ 修正: 通信戦略自体の接続を（ループの外で）切断
		try {
			await this.commStrategy.disconnect();
			log.debug('CommunicationStrategy の接続を切断しました。');
		} catch (error) {
			log.warn('CommunicationStrategy の切断中にエラーが発生しました。', error);
		}

		this.initialized = false;
		this.accounts.clear();
		log.info('すべての接続が切断されました。');
	}
}