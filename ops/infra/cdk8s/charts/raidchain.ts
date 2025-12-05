import { Chart, ChartProps } from 'cdk8s';
import * as kplus from 'cdk8s-plus-27';
import { Construct } from 'constructs';
import { createEntrypointChainScript, createRelayerInitScript } from './scripts';

export interface ChainConfig {
	name: string;
	type: 'gwc' | 'mdsc' | 'fdsc';
}

export interface ChainTypeConfig {
	repository: string;
	tag: string;
}

export interface RaidChainProps extends ChartProps {
	releaseName: string; // リソースのプレフィックス等に使用
	devMode: boolean;
	chains: ChainConfig[];
	chainTypes: Record<string, ChainTypeConfig>;
	relayer: {
		repository: string;
		tag: string;
		pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
	};
	storageSize: string;
}

export class RaidChainChart extends Chart {
	constructor(scope: Construct, id: string, props: RaidChainProps) {
		super(scope, id, props);

		// ========================================================================
		// 1. Scripts (Generated from TypeScript)
		// ========================================================================
		// ファイル読み込みではなく、TS関数からスクリプト文字列を生成
		const scriptsConfigMap = new kplus.ConfigMap(this, 'Scripts');

		const headlessServiceName = `chain-headless`; // 後で使用するService名

		scriptsConfigMap.addData('entrypoint-chain.sh', createEntrypointChainScript(props));
		scriptsConfigMap.addData('init-relayer.sh', createRelayerInitScript(props, headlessServiceName));

		// Mnemonics Secret (Placeholder)
		const mnemonicsSecret = new kplus.Secret(this, 'Mnemonics');

		// ========================================================================
		// 2. Chain Nodes (StatefulSets)
		// ========================================================================

		// Service定義: StatefulSetのHeadless Serviceとして機能
		// cdk8s-plusのStatefulSetはデフォルトでServiceを作るが、
		// 名前解決を確実にするため、Service名を固定または参照可能にする

		props.chains.forEach((chain) => {
			const typeConfig = props.chainTypes[chain.type];

			const statefulSet = new kplus.StatefulSet(this, `chain-${chain.name}`, {
				metadata: {
					name: `${props.releaseName}-${chain.name}`,
					labels: {
						'app.kubernetes.io/component': chain.type,
						'app.kubernetes.io/instance': chain.name,
					}
				},
				replicas: 1,
				service: {
					metadata: {
						name: `${props.releaseName}-${chain.name}-chain-headless` // 既存Helmと名前を変える場合は注意
					},
					clusterIP: 'None', // Headless
					ports: [
						{ name: 'rpc', port: 26657 },
						{ name: 'grpc', port: 9090 },
						{ name: 'api', port: 1317 }
					]
				}
			});

			// cdk8s-plusの仕様上、Service名は自動生成される場合があるため、
			// ここではスクリプト内で使用する headlessServiceName は
			// cdk8s-plusが生成するService名と一致させる必要があります。
			// 今回は簡易化のため、init-relayer.sh 側で StatefulSet のPod名ルールに基づくDNS名を構築しています。
			// (statefulset-name-0.service-name.namespace...)

			// コンテナ定義
			const container = statefulSet.addContainer({
				name: 'chain',
				image: `${typeConfig.repository}:${typeConfig.tag}`,
				imagePullPolicy: kplus.ImagePullPolicy.IF_NOT_PRESENT,
				command: ['/bin/bash', '/scripts/entrypoint-chain.sh'], // bashに変更
				envVariables: {
					CHAIN_APP_NAME: kplus.EnvValue.fromValue(chain.type),
					CHAIN_INSTANCE_NAME: kplus.EnvValue.fromValue(chain.name),
					DEV_MODE: kplus.EnvValue.fromValue(props.devMode.toString()),
				},
				ports: [
					{ name: 'rpc', number: 26657 },
					{ name: 'grpc', number: 9090 },
					{ name: 'api', number: 1317 },
				]
			});

			// ボリュームマウント
			container.mount('/scripts', kplus.Volume.fromConfigMap(this, `ScriptsVol-${chain.name}`, scriptsConfigMap));
			container.mount('/etc/mnemonics', kplus.Volume.fromSecret(this, `MnemonicsVol-${chain.name}`, mnemonicsSecret));

			const dataPvc = new kplus.PersistentVolumeClaim(this, `DataPvc-${chain.name}`, {
				accessModes: [kplus.PersistentVolumeAccessMode.READ_WRITE_ONCE],
				storage: kplus.Size.gibibytes(parseInt(props.storageSize.replace('Gi', ''))),
			});
			container.mount('/home/' + chain.type + '/.' + chain.type, kplus.Volume.fromPersistentVolumeClaim(this, `Vol-${chain.name}`, dataPvc));
		});

		// ========================================================================
		// 3. Relayer (Deployment)
		// ========================================================================

		const relayerDeployment = new kplus.Deployment(this, 'Relayer', {
			metadata: {
				name: `${props.releaseName}-relayer`
			},
			replicas: 1,
			containers: [{
				name: 'relayer',
				image: `${props.relayer.repository}:${props.relayer.tag}`,
				imagePullPolicy: props.relayer.pullPolicy === 'Always'
					? kplus.ImagePullPolicy.ALWAYS
					: kplus.ImagePullPolicy.IF_NOT_PRESENT,
				command: ['/bin/bash', '/scripts/init-relayer.sh'], // bashに変更
				envVariables: {
					RELEASE_NAME: kplus.EnvValue.fromValue(props.releaseName),
					// スクリプト内でHeadless Serviceのドメインを構築するために必要
					// cdk8s-plusで作成したHeadless Serviceの名前を正しく渡す必要があります
					// ひとまず共通のSuffixとして定義
					HEADLESS_SERVICE_NAME: kplus.EnvValue.fromValue(headlessServiceName),
				},
				volumeMounts: [
					{
						path: '/scripts',
						volume: kplus.Volume.fromConfigMap(this, 'RelayerScriptsVol', scriptsConfigMap)
					},
					{
						path: '/etc/relayer/mnemonics',
						volume: kplus.Volume.fromSecret(this, 'RelayerMnemonicsVol', mnemonicsSecret)
					}
				]
			}]
		});
	}
}