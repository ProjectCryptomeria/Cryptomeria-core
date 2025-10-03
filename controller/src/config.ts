// 🚨 注意: このファイルにニーモニックをハードコードするのはPoC目的のみです。
// 本番環境では、環境変数やシークレット管理サービスを使用してください。

// 各チェーンのRPCエンドポイント
// 開発コンテナからアクセスするため、Kubernetesのサービス名を使用します。
export const chainEndpoints = {
	'data-0': 'http://raidchain-data-0-0.raidchain-chain-headless.raidchain.svc.cluster.local:26657',
	'data-1': 'http://raidchain-data-1-0.raidchain-chain-headless.raidchain.svc.cluster.local:26657',
	'meta-0': 'http://raidchain-meta-0-0.raidchain-chain-headless.raidchain.svc.cluster.local:26657',
};

// チェーンごとの設定
export const chainConfig = {
	'data-0': {
		chainId: 'data-0',
		prefix: 'cosmos',
		denom: 'uatom',
	},
	'data-1': {
		chainId: 'data-1',
		prefix: 'cosmos',
		denom: 'uatom',
	},
	'meta-0': {
		chainId: 'meta-0',
		prefix: 'cosmos',
		denom: 'uatom',
	},
};


// entrypoint-chain.shで`creator`としてHDパス(--account 2)を指定して作成したアカウントのニーモニック
// 🚨 このニーモニックは `make deploy` を実行するたびに変わる可能性があります。
// 実際の値は `raidchain-mnemonics` Secret から取得してください。
// kubectl get secret raidchain-mnemonics -n raidchain -o jsonpath='{.data.data-0\.mnemonic}' | base64 -d
export const creatorMnemonic = 'your mnemonic here';

// ファイルを分割する際のチャンクサイズ (バイト単位)
// 例: 16 KB
export const CHUNK_SIZE = 16 * 1024;