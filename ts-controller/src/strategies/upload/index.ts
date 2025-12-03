// controller/src/strategies/upload/index.ts

// 最上位のインターフェース
export * from './interfaces/IUploadStrategy';

// 最終的な具象実装
export * from './implement/CompositeUploadStrategy';

// 内部実装（Allocator, Transmitter, BaseCoreLogic, 他のインターフェース）は
// 外部 (run-experiment.ts) に公開する必要はない。