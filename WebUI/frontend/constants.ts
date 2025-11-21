
import { AppLayer } from './types';
import { Activity, Server, Coins, TestTube, Library, ScrollText } from 'lucide-react';

/**
 * ナビゲーションメニューの設定
 * サイドバーに表示される項目、アイコン、ラベルを定義します。
 */
export const NAV_ITEMS = [
  {
    id: AppLayer.MONITORING,
    label: 'Monitoring',
    subLabel: 'リアルタイム監視',
    icon: Activity,
  },
  {
    id: AppLayer.DEPLOYMENT,
    label: 'Deployment',
    subLabel: 'インフラ管理',
    icon: Server,
  },
  {
    id: AppLayer.ECONOMY,
    label: 'Economy',
    subLabel: 'アカウント・資金',
    icon: Coins,
  },
  {
    id: AppLayer.PRESET,
    label: 'Presets',
    subLabel: 'プリセット管理',
    icon: ScrollText,
  },
  {
    id: AppLayer.EXPERIMENT,
    label: 'Experiment',
    subLabel: '実験実行',
    icon: TestTube,
  },
  {
    id: AppLayer.LIBRARY,
    label: 'Library',
    subLabel: '結果アーカイブ',
    icon: Library,
  },
];

/**
 * デプロイメント画面のコンソール初期ログ
 */
export const MOCK_INITIAL_LOGS = [
  "[System] RaidChain WebUI Controller initialized.",
  "[System] Connected to Kubernetes Cluster (minikube).",
  "[System] Database integrity check passed.",
];
