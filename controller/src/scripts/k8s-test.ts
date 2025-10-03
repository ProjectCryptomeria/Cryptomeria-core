import * as k8s from '@kubernetes/client-node';
import { V1Pod } from '@kubernetes/client-node';
import { K8S_NAMESPACE } from '../config'; // ★★★ 修正箇所 ★★★

async function main() {
	console.log('🚀 Starting Kubernetes API connection test...');

	try {
		// 1. Kubernetesの設定をロード
		const kc = new k8s.KubeConfig();
		kc.loadFromDefault();

		// 2. CoreV1Apiのクライアントを作成
		const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
		console.log(`✅ Kubernetes client loaded. Trying to connect to namespace: "${K8S_NAMESPACE}"...`);

		// 3. Namespace内のPod一覧を取得
		const podRes = await k8sApi.listNamespacedPod({
			namespace: K8S_NAMESPACE
		});
		const podNames = podRes.items.map((pod: V1Pod) => pod.metadata?.name);

		if (podNames.length > 0) {
			console.log(`✅ Successfully connected to the cluster and found pods in namespace "${K8S_NAMESPACE}":`);
			podNames.forEach((name?: string) => console.log(`  - ${name}`));
		} else {
			console.warn(`⚠️  Connection successful, but no pods found in namespace "${K8S_NAMESPACE}".`);
		}

		console.log('\n🎉 Test complete!');

	} catch (err) {
		console.error('🔥 Failed to connect to Kubernetes cluster or list pods.');
		if (err instanceof Error) {
			console.error('   Error message:', err.message);
			if (err.stack) {
				console.error('   Stack trace:', err.stack);
			}
		} else {
			console.error('   An unknown error occurred:', err);
		}
		console.error('\n   Please ensure that your Kubernetes context is configured correctly (`kubectl config current-context`) or that this script is running inside a pod with appropriate RBAC permissions.');
		process.exit(1);
	}
}

// --- スクリプトの実行 ---
main().catch(console.error);