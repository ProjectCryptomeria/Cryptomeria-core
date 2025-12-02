package keeper

import (
	"context"
	"encoding/json" // 追加
	"errors"
	"fmt" // 追加

	"mdsc/x/metastore/types"

	"cosmossdk.io/collections"
	"github.com/cosmos/cosmos-sdk/types/query"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (q queryServer) ListManifest(ctx context.Context, req *types.QueryAllManifestRequest) (*types.QueryAllManifestResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	manifests, pageRes, err := query.CollectionPaginate(
		ctx,
		q.k.Manifest,
		req.Pagination,
		func(_ string, value types.Manifest) (types.Manifest, error) {
			return value, nil
		},
	)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	// === [DEBUG START] 自前でJSON化して確認 ===
	fmt.Println("========== DEBUG: ListManifest JSON Check ==========")
	if len(manifests) > 0 {
		// Go標準の json.Marshal を使用 (gogoproto/jsonpb ではない)
		// これにより、構造体タグ `json:"..."` が正しく効いているか確認できる
		bz, err := json.MarshalIndent(manifests, "", "  ")
		if err != nil {
			fmt.Printf("DEBUG ERROR: json.Marshal failed: %v\n", err)
		} else {
			fmt.Println(string(bz))
		}
	} else {
		fmt.Println("DEBUG: No manifests found.")
	}
	fmt.Println("====================================================")
	// === [DEBUG END] ===

	return &types.QueryAllManifestResponse{Manifest: manifests, Pagination: pageRes}, nil
}

func (q queryServer) GetManifest(ctx context.Context, req *types.QueryGetManifestRequest) (*types.QueryGetManifestResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	val, err := q.k.Manifest.Get(ctx, req.ProjectName)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.NotFound, "not found")
		}

		return nil, status.Error(codes.Internal, "internal error")
	}

	return &types.QueryGetManifestResponse{Manifest: val}, nil
}
