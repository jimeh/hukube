package server

import (
	"context"
	"fmt"
	"io"

	corev1 "k8s.io/api/core/v1"

	"github.com/jimeh/hukube/engine/internal/cluster"
	"github.com/jimeh/hukube/engine/internal/logstream"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

var openPodLogs = (*cluster.Cluster).OpenPodLogs

type logCluster struct {
	*cluster.Cluster
	open func(*cluster.Cluster, context.Context, string, string, *corev1.PodLogOptions) (io.ReadCloser, error)
}

func (c logCluster) OpenPodLogs(ctx context.Context, namespace, name string, options *corev1.PodLogOptions) (io.ReadCloser, error) {
	return c.open(c.Cluster, ctx, namespace, name, options)
}

type logConsumer struct {
	streamOutput[protocol.LogStreamStatus]
}

func (c logConsumer) Frame(frame []byte, records int)        { c.frame(frame, records) }
func (c logConsumer) Status(status protocol.LogStreamStatus) { c.event(status) }

func init() {
	handleStream(protocol.StreamResourceLogs, func(ctx context.Context, srv *Server, p protocol.LogStreamParams, out streamOutput[protocol.LogStreamStatus]) protocol.StreamEnd {
		if p.Cluster == "" || p.Type == "" || p.Name == "" || p.UID == "" {
			return streamError(badRequest(fmt.Errorf("cluster, type, name, and uid are required")))
		}
		c, err := srv.cfg.Clusters.Get(p.Cluster)
		if err != nil {
			return streamError(err)
		}
		return logstream.Run(ctx, logCluster{c, openPodLogs}, c.Graph, p, logConsumer{out}, logstream.DefaultTiming)
	})
}
