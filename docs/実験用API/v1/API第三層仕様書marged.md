# API第三層仕様書（Utilities / Experiment Layer）統合版

- 対象: Cryptomeria-BFF v1
- 版: 1.0.0
- 最終更新: 2026-01-23
- Base Path: `/api/v1/utils`

この層の目的:
- 実験・観測・データ取得・負荷試験など「便利機能」を提供する
- 長時間/高負荷になり得る処理は **非同期ジョブ化**し、実験の再現性・運用性を上げる
- TPS/throughput は **ブロックヘッダ時刻ベース**で統一定義し、比較可能性を担保する

> 本仕様書は **第3層（Utilities）** のみを対象とする。  
> 目的は、卒研・実験・負荷試験・データ取得で頻出する「測る・まとめる・流す・記録する」をBFF側でユーティリティとして提供し、実験用スクリプト/クライアントを簡単にすること。  
> 第2層（Blockchain）を “部品API” として組み合わせ、統計・バッチ処理・スナップショット化・観測補助を行う。  
> 認証・権限・ADMIN等の概念は本要件から撤廃し、仕様書でも扱わない。

> 第3層のジョブモデルは **APIJOB仕様書.md** に準拠する。  
> 本仕様書では Utilities スコープの job type / step / リクエスト仕様を規定する。

---

## 0. パス表記のメモ（旧仕様との対応）
- **新（本仕様）**: Base Path は `/api/v1/utils`
- **旧仕様（Draft）**: BasePath `/api/v1` + Prefix `/utils`（= `/api/v1/utils` 相当）

---

## 1. 共通仕様

### 1.1 Content-Type
- Request/Response は基本 `application/json; charset=utf-8`

### 1.2 エラー形式（共通）
```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "timeoutMs must be >= 1000",
    "details": { "field": "timeoutMs" }
  }
}
```

代表 code:
- `INVALID_ARGUMENT` (400)
- `NOT_FOUND` (404)
- `CONFLICT` (409) : 排他
- `RATE_LIMITED` (429) : 並列/レート制限
- `UPSTREAM_UNAVAILABLE` (503)
- `UPSTR
