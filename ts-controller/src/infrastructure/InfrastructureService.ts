// controller/src/infrastructure/InfrastructureService.ts
import * as k8s from '@kubernetes/client-node';
import { ChainEndpoints, ChainInfo, ChainType } from '../types';
import { log } from '../utils/logger';
import { sleep } from '../utils/retry';

const K8S_NAMESPACE = process.env.K8S_NAMESPACE || 'raidchain';
const SECRET_NAME = process.env.SECRET_NAME || 'raidchain-mnemonics';
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 2000;

export class InfrastructureService {
	private k8sApi: k8s.CoreV1Api;
	private mnemonicCache = new Map<string, string>();
	private chainInfoCache: ChainInfo[] | null = null;
	private chainInfoPromise: Promise<ChainInfo[]> | null = null;

	constructor() {
		try {
			const kc = new k8s.KubeConfig();
			kc.loadFromDefault();
			this.k8sApi = kc.makeApiClient(k8s.CoreV1Api);
			log.info('Kubernetes API クライアントを初期化しました。');
		} catch (error) {
			log.error('Kubernetes設定の読み込みまたはAPIクライアントの初期化に失敗しました。');
			log.error('kubectlが設定されているか、またはIn-Cluster環境で実行されているか確認してください。', error);
			process.exit(1);
		}
	}

	/**
	 * Kubernetesクラスタからチェーン情報 (名前とタイプ) を取得します。
	 */
	public async getChainInfo(): Promise<ChainInfo[]> {
		if (this.chainInfoCache) {
			log.debug('チェーン情報キャッシュが見つかりました。キャッシュを返します。');
			return this.chainInfoCache;
		}
		if (this.chainInfoPromise) {
			log.debug('チェーン情報取得処理が進行中です。完了を待ちます...');
			return this.chainInfoPromise;
		}

		log.info('Kubernetes API からチェーン情報 (Pod) の取得を開始します...');
		this.chainInfoPromise = this._fetchChainInfoWithRetry();

		try {
			const info = await this.chainInfoPromise;
			this.chainInfoCache = info;
			log.info(`チェーン情報 (${info.length}件) を取得し、キャッシュしました。`);
			return info;
		} catch (error) {
			log.error('チェーン情報の取得に失敗しました。', error);
			throw error;
		} finally {
			this.chainInfoPromise = null;
		}
	}

	/**
	 * チェーン情報取得のコアロジック（リトライ付き）
	 */
	private async _fetchChainInfoWithRetry(): Promise<ChainInfo[]> {
		let retries = 0;
		let lastError: any;

		while (retries < MAX_RETRIES) {
			try {
				log.debug(`Namespace "${K8S_NAMESPACE}" 内のチェーンPodを検索中... (試行 ${retries + 1}/${MAX_RETRIES})`);

				// ★ 修正: param オブジェクト形式で呼び出し
				const res = await this.k8sApi.listNamespacedPod({
					namespace: K8S_NAMESPACE,
					labelSelector: 'app.kubernetes.io/component in (datachain, metachain)'
				});

				// ★ 修正: res.body.items ではなく res.items を参照
				const pods = res.items;
				if (!pods || pods.length === 0) {
					throw new Error('クラスタ内にチェーンPodが見つかりません。アプリケーションはデプロイされていますか？');
				}

				// Pod情報からChainInfoオブジェクトを作成 (以降のロジックは変更なし)
				const info: ChainInfo[] = pods.map((pod: k8s.V1Pod) => {
					const name = pod.metadata?.labels?.['app.kubernetes.io/instance'];
					const type = pod.metadata?.labels?.['app.kubernetes.io/component'] as ChainType | undefined;

					if (!name || !type) {
						log.warn(`Pod ${pod.metadata?.name ?? '名前不明'} に必要なラベル ('app.kubernetes.io/instance' または 'app.kubernetes.io/component') がありません。スキップします。`);
						return null;
					}
					if (type !== 'datachain' && type !== 'metachain') {
						log.warn(`Pod ${pod.metadata?.name ?? '名前不明'} のコンポーネントタイプ '${type}' は無効です。スキップします。`);
						return null;
					}
					return { name, type };
				})
					.filter((item): item is ChainInfo => item !== null)
					.sort((a, b) => a.name.localeCompare(b.name));

				log.debug(`検出されたチェーン: ${JSON.stringify(info.map(c => c.name))}`);
				return info;

			} catch (err) {
				lastError = err;
				if (retries < MAX_RETRIES - 1) {
					log.warn(`チェーンPodの検索に失敗しました。${RETRY_DELAY_MS}ms 後にリトライします... (エラー: ${lastError instanceof Error ? lastError.message : String(lastError)})`);
					await sleep(RETRY_DELAY_MS);
				}
				retries++;
			}
		}
		log.error(`リトライ上限 (${MAX_RETRIES}回) に達してもチェーン情報の取得に失敗しました。`);
		throw lastError;
	}

	/**
	 * 指定されたチェーンのニーモニックをKubernetes Secretから取得します。
	 */
	public async getCreatorMnemonic(chainName: string): Promise<string> {
		if (this.mnemonicCache.has(chainName)) {
			log.debug(`ニーモニックキャッシュ (${chainName}) が見つかりました。キャッシュを返します。`);
			return this.mnemonicCache.get(chainName)!;
		}

		try {
			const MNEMONIC_KEY = `${chainName}.mnemonic`;
			log.info(`Secret "${SECRET_NAME}" からキー "${MNEMONIC_KEY}" の取得を試みます...`);

			// param オブジェクト形式で呼び出し
			const res = await this.k8sApi.readNamespacedSecret({
				name: SECRET_NAME,
				namespace: K8S_NAMESPACE
			});

			// bodyプロパティ存在しない
			const secret = res;

			if (!secret.data || !secret.data[MNEMONIC_KEY]) {
				throw new Error(`Secret "${SECRET_NAME}" にキー "${MNEMONIC_KEY}" が見つかりません。`);
			}

			const encodedMnemonic = secret.data[MNEMONIC_KEY];
			const decodedMnemonic = Buffer.from(encodedMnemonic, 'base64').toString('utf-8');

			if (!decodedMnemonic) {
				throw new Error(`キー "${MNEMONIC_KEY}" のニーモニックのデコードに失敗しました。`);
			}

			log.info(`"${chainName}" のニーモニックを取得し、デコードしました。`);
			this.mnemonicCache.set(chainName, decodedMnemonic);
			return decodedMnemonic;

		} catch (err) {
			log.error(`"${chainName}" のニーモニック取得中にエラーが発生しました。Secret "${SECRET_NAME}" が存在し、キー "${chainName}.mnemonic" が正しく設定されているか確認してください。`, err);
			process.exit(1);
		}
	}

	/**
	 * すべてのチェーンのRPCエンドポイントを取得します。
	 */
	public async getRpcEndpoints(): Promise<ChainEndpoints> {
		const chainInfos = await this.getChainInfo();
		const endpoints: ChainEndpoints = {};
		const isLocal = process.env.NODE_ENV !== 'production';

		log.info(`RPCエンドポイントを生成中 (${isLocal ? 'ローカル (NodePort)' : 'クラスター内部'} モード)...`);

		try {
			// ★ 修正: _listNamespacedServicesWithRetry を使用
			const services = await this._listNamespacedServicesWithRetry('app.kubernetes.io/category=chain');

			for (const chain of chainInfos) {
				// (以降のエンドポイント生成ロジックは変更なし)
				const serviceName = `raidchain-${chain.name}-headless`;
				const service = services.find(s => s.metadata?.name === serviceName);

				if (!service || !service.spec || !service.spec.ports) {
					throw new Error(`チェーン "${chain.name}" に対応する Service "${serviceName}" またはポートが見つかりません。`);
				}

				const portInfo = service.spec.ports.find(p => p.name === 'rpc');

				if (isLocal) {
					if (!portInfo || !portInfo.nodePort) {
						throw new Error(`Service "${serviceName}" の RPC (rpc) NodePort が見つかりません。`);
					}
					endpoints[chain.name] = `http://localhost:${portInfo.nodePort}`;
				} else {
					const podHostName = `raidchain-${chain.name}-0`;
					const headlessServiceName = `raidchain-chain-headless`;
					const clusterPort = portInfo?.port ?? 26657;
					endpoints[chain.name] = `http://${podHostName}.${headlessServiceName}.${K8S_NAMESPACE}.svc.cluster.local:${clusterPort}`;
				}
				log.debug(` -> ${chain.name} (RPC): ${endpoints[chain.name]}`);
			}
		} catch (err) {
			log.error("RPCエンドポイントの取得中にエラーが発生しました。", err);
			throw err;
		}

		log.info(`RPCエンドポイント (${Object.keys(endpoints).length}件) の生成が完了しました。`);
		return endpoints;
	}

	/**
	 * すべてのチェーンのREST APIエンドポイントを取得します。
	 */
	public async getApiEndpoints(): Promise<ChainEndpoints> {
		const chainInfos = await this.getChainInfo();
		const endpoints: ChainEndpoints = {};
		const isLocal = process.env.NODE_ENV !== 'production';

		log.info(`APIエンドポイントを生成中 (${isLocal ? 'ローカル (NodePort)' : 'クラスター内部'} モード)...`);

		try {
			// ★ 修正: _listNamespacedServicesWithRetry を使用
			const services = await this._listNamespacedServicesWithRetry('app.kubernetes.io/category=chain');

			for (const chain of chainInfos) {
				// (以降のエンドポイント生成ロジックは変更なし)
				const serviceName = `raidchain-${chain.name}-headless`;
				const service = services.find(s => s.metadata?.name === serviceName);

				if (!service || !service.spec || !service.spec.ports) {
					throw new Error(`チェーン "${chain.name}" に対応する Service "${serviceName}" またはポートが見つかりません。`);
				}

				const portInfo = service.spec.ports.find(p => p.name === 'api');

				if (isLocal) {
					if (!portInfo || !portInfo.nodePort) {
						throw new Error(`Service "${serviceName}" の API (api) NodePort が見つかりません。`);
					}
					endpoints[chain.name] = `http://localhost:${portInfo.nodePort}`;
				} else {
					const podHostName = `raidchain-${chain.name}-0`;
					const headlessServiceName = `raidchain-chain-headless`;
					const clusterPort = portInfo?.port ?? 1317;
					endpoints[chain.name] = `http://${podHostName}.${headlessServiceName}.${K8S_NAMESPACE}.svc.cluster.local:${clusterPort}`;
				}
				log.debug(` -> ${chain.name} (API): ${endpoints[chain.name]}`);
			}
		} catch (err) {
			log.error("APIエンドポイントの取得中にエラーが発生しました。", err);
			throw err;
		}

		log.info(`APIエンドポイント (${Object.keys(endpoints).length}件) の生成が完了しました。`);
		return endpoints;
	}

	/**
	 * Namespace内のServiceをリストアップする（リトライ付き）
	 */
	private async _listNamespacedServicesWithRetry(labelSelector: string): Promise<k8s.V1Service[]> {
		let retries = 0;
		let lastError: any;

		while (retries < MAX_RETRIES) {
			try {
				log.debug(`Namespace "${K8S_NAMESPACE}" 内のService (label: ${labelSelector}) を検索中... (試行 ${retries + 1}/${MAX_RETRIES})`);

				// param オブジェクト形式で呼び出し
				const res = await this.k8sApi.listNamespacedService({
					namespace: K8S_NAMESPACE,
					labelSelector: labelSelector
				});

				// res.body.items ではなく res.items を参照
				if (!res.items) {
					throw new Error('Serviceリストの取得に失敗しました (items not found)。');
				}
				return res.items;

			} catch (err) {
				lastError = err;
				if (retries < MAX_RETRIES - 1) {
					log.warn(`Serviceリストの取得に失敗しました。${RETRY_DELAY_MS}ms 後にリトライします... (エラー: ${lastError instanceof Error ? lastError.message : String(lastError)})`);
					await sleep(RETRY_DELAY_MS);
				}
				retries++;
			}
		}
		log.error(`リトライ上限 (${MAX_RETRIES}回) に達してもServiceリストの取得に失敗しました。`);
		throw lastError;
	}
}