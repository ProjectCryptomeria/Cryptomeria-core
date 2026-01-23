package keeper_test

import (
	"encoding/hex"
	"testing"

	"gwc/x/gateway/keeper"

	"github.com/stretchr/testify/require"
)

func TestCalculateSiteRoot_Deterministic(t *testing.T) {
	// ケース1: 正常な順序
	files1 := []keeper.ProcessedFile{
		{Path: "assets/css/style.css", Content: []byte("body { color: red; }")},
		{Path: "index.html", Content: []byte("<html>hello</html>")},
	}

	// ケース2: 逆順 (Zip作成時の順序ゆらぎをシミュレート)
	files2 := []keeper.ProcessedFile{
		{Path: "index.html", Content: []byte("<html>hello</html>")},
		{Path: "assets/css/style.css", Content: []byte("body { color: red; }")},
	}

	// 両方で計算
	root1, map1, err1 := keeper.CalculateSiteRoot(files1)
	require.NoError(t, err1)

	root2, map2, err2 := keeper.CalculateSiteRoot(files2)
	require.NoError(t, err2)

	// 検証: 入力順序が違っても、ソートされて同じRootになるはず
	require.Equal(t, root1, root2, "SiteRoot should be deterministic regardless of input order")
	require.Equal(t, map1["index.html"], map2["index.html"], "FileRoot should match")
}

func TestCalculateMerkleRoot_Structure(t *testing.T) {
	// 単一ファイルのテスト
	files := []keeper.ProcessedFile{
		{Path: "a.txt", Content: []byte("test")},
	}
	// チャンク分割をシミュレート (手動設定)
	files[0].Chunks = [][]byte{[]byte("test")}

	root, _, err := keeper.CalculateSiteRoot(files)
	require.NoError(t, err)
	require.NotEmpty(t, root)

	// ハッシュ値の長さ確認 (SHA256 hex string = 64 chars)
	require.Len(t, root, 64)
	_, err = hex.DecodeString(root)
	require.NoError(t, err, "Root should be valid hex string")
}
