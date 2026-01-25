---
DocType: GUIDE
SourceOfTruth: code
Status: draft
LastReviewed: 2026-01-25
Owners: TBD
---

# Reference（CLI / HTTP 最小リファレンス）

## 1. 方針
- この文書は “薄く” 保つ（詳細はコードへ）
- 変更に追随する（SourceOfTruth: code）

## 2. GWC CLI（Query）
### 2.1 Params
- `gwcd q gateway params`

### 2.2 Endpoints
- `gwcd q gateway endpoints`

### 2.3 Download
- `gwcd q gateway download [filename] --project [project] --save-dir [dir]`

## 3. GWC CLI（Tx / CSU）
> Upload の実体は “CSU コマンド列” の組み合わせ。

- `gwcd tx gateway init-session [executor] [fragment-size] [deadline-unix]`
- `gwcd tx gateway commit-root-proof [session-id] [root-proof-hex]`
- `gwcd tx gateway distribute-batch [session-id] [items.json]`
- `gwcd tx gateway finalize-and-close [session-id] [manifest.json]`
- `gwcd tx gateway abort-and-close [session-id] [reason]`

### 3.1 Register Storage（運用）
- `gwcd tx gateway register-storage [channel-id] [chain-id] [api-endpoint] [connection-type]`
  - connection-type は `mdsc` または `fdsc`

## 4. HTTP（GWC）
- `GET /render/{project}/{version}/{path...}`  
  - 参照解決 → 復元 → レスポンス

## 5. 主要 JSON フォーマット（抜粋）
### 5.1 distribute-batch items.json（概略）
```json
{
  "items": [
    {
      "path": "index.html",
      "index": 0,
      "fragment_bytes_base64": "...",
      "fragment_proof": {"steps":[{"sibling_hex":"...","sibling_is_left":true}]},
      "file_size": 123,
      "file_proof": {"steps":[...]}
    }
  ]
}
```

### 5.2 finalize manifest.json（概略）
```json
{
  "project_name": "my-project",
  "version": "v1",
  "files": { "...": { "mime_type": "...", "size": 123, "fragments": [...] } },
  "root_proof": "0x...",
  "fragment_size": 1048576,
  "owner": "cosmos1...",
  "session_id": "..."
}
```
