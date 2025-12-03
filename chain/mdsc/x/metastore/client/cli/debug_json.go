package cli

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"
)

// 検証用の単純なネスト構造体を定義
// Proto生成物に依存せず、純粋なGoの構造体でJSON化をテストします

// 1. 最下層 (FragmentLocation 相当)
type DebugItem struct {
	ID    string `json:"id"`
	Value int    `json:"value"`
}

// 2. 中間層 (FileInfo 相当: スライスを持つ)
type DebugCategory struct {
	Description string       `json:"description"`
	Items       []*DebugItem `json:"items"` // スライスのネスト
}

// 3. 最上位 (Manifest 相当: マップを持つ)
type DebugRoot struct {
	Title      string                    `json:"title"`
	Categories map[string]*DebugCategory `json:"categories"` // マップのネスト
}

func CmdDebugJSON() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "debug-json",
		Short: "Debug command with simple nested struct",
		Long:  "Proto定義を使わず、純粋なGo構造体でネスト（Map/Slice）を作成し、JSON出力をテストします。",
		RunE: func(cmd *cobra.Command, args []string) error {
			// データ作成

			// 最下層
			item1 := &DebugItem{ID: "item-1", Value: 100}
			item2 := &DebugItem{ID: "item-2", Value: 200}

			// 中間層 (スライスに格納)
			categoryData := &DebugCategory{
				Description: "This is a test category",
				Items:       []*DebugItem{item1, item2},
			}

			// 最上位 (マップに格納)
			root := DebugRoot{
				Title: "Debug Root Object",
				Categories: map[string]*DebugCategory{
					"cat-A": categoryData,
				},
			}

			// 出力確認
			fmt.Println("--- Go Struct Dump ---")
			fmt.Printf("%+v\n\n", root)

			// JSONマーシャリング
			bz, err := json.MarshalIndent(root, "", "  ")
			if err != nil {
				return err
			}

			fmt.Println("--- JSON Output ---")
			fmt.Println(string(bz))

			return nil
		},
	}
	return cmd
}
