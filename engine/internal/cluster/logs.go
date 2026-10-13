package cluster

import (
	"context"
	"io"

	corev1 "k8s.io/api/core/v1"
)

// OpenPodLogs opens a log request with its own client and no request timeout.
func (c *Cluster) OpenPodLogs(ctx context.Context, namespace, name string, options *corev1.PodLogOptions) (io.ReadCloser, error) {
	return c.logs.Pods(namespace).GetLogs(name, options).Stream(ctx)
}
