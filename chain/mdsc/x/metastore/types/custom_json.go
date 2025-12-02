package types

import (
	"encoding/json"
	"fmt"
	"os"
)

// 呼び出されることが確定している「実体レシーバ」での実装に戻します
func (m FileInfo) MarshalJSON() ([]byte, error) {
	type Alias FileInfo
	// タグ重複が解消されていれば、ここで正しくJSON化されるはずです
	bz, err := json.Marshal((Alias)(m))

	// デバッグログ: 生成されたJSONを確認
	if err != nil {
		fmt.Fprintf(os.Stderr, "DEBUG: JSON Marshal Error: %v\n", err)
	} else {
		fmt.Fprintf(os.Stderr, "DEBUG: JSON Marshal Result: %s\n", string(bz))
	}

	return bz, err
}
