package server

import (
	"context"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

const readOnlyReason = "The Engine is running read-only. Editing and deleting Resources are disabled."

func init() {
	handleRequest(protocol.RequestResourceReview, func(ctx context.Context, srv *Server, p protocol.ResourceEdit) (protocol.EditReview, error) {
		c, err := srv.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return protocol.EditReview{}, err
		}
		return c.Review(ctx, p)
	})
	handleMutation(protocol.RequestResourceApply, func(ctx context.Context, srv *Server, p protocol.ResourceEdit) (protocol.ApplyResult, error) {
		c, err := srv.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return protocol.ApplyResult{}, err
		}
		return c.Apply(ctx, p)
	})
	handleMutation(protocol.RequestResourceDelete, func(ctx context.Context, srv *Server, p protocol.DeleteParams) (protocol.None, error) {
		c, err := srv.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return protocol.None{}, err
		}
		return protocol.None{}, c.Delete(ctx, p)
	})
	handleRequest(protocol.RequestResourceAccess, func(ctx context.Context, srv *Server, p protocol.ResourceRef) (protocol.ResourceAccess, error) {
		if srv.cfg.ReadOnly {
			return protocol.ResourceAccess{Edit: protocol.Access{Reason: readOnlyReason}, Delete: protocol.Access{Reason: readOnlyReason}}, nil
		}
		c, err := srv.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return protocol.ResourceAccess{}, err
		}
		return c.Access(ctx, p)
	})
}
