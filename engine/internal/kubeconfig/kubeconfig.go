// Package kubeconfig lists Clusters and resolves their credentials.
package kubeconfig

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

// ErrUnknownCluster is returned for a Cluster ID the Source does not know.
var ErrUnknownCluster = errors.New("unknown cluster")

// Source lists Clusters and resolves their credentials. It is the only way
// the Engine obtains cluster credentials, so per-user identity can replace
// kubeconfig files without touching anything else (see ADR-0007).
type Source interface {
	Clusters() ([]protocol.Cluster, error)
	RESTConfig(clusterID string) (*rest.Config, error)
}

// FileSource reads kubeconfig files the same way kubectl does. Files are
// re-read on every call so edits are picked up without a restart.
type FileSource struct {
	rules *clientcmd.ClientConfigLoadingRules
}

// NewFileSource returns a Source for the kubeconfig at path, or for
// $KUBECONFIG and ~/.kube/config when path is empty.
func NewFileSource(path string) *FileSource {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	rules.ExplicitPath = path
	return &FileSource{rules: rules}
}

// Clusters returns one Cluster per kubeconfig context, sorted by ID.
func (s *FileSource) Clusters() ([]protocol.Cluster, error) {
	cfg, err := s.rules.Load()
	if err != nil {
		return nil, fmt.Errorf("load kubeconfig: %w", err)
	}
	clusters := make([]protocol.Cluster, 0, len(cfg.Contexts))
	for name, kctx := range cfg.Contexts {
		c := protocol.Cluster{
			ID:        name,
			User:      kctx.AuthInfo,
			Namespace: kctx.Namespace,
			Current:   name == cfg.CurrentContext,
		}
		if kc, ok := cfg.Clusters[kctx.Cluster]; ok {
			c.Server = kc.Server
		}
		clusters = append(clusters, c)
	}
	slices.SortFunc(clusters, func(a, b protocol.Cluster) int { return strings.Compare(a.ID, b.ID) })
	return clusters, nil
}

// RESTConfig returns client configuration for the context named clusterID.
func (s *FileSource) RESTConfig(clusterID string) (*rest.Config, error) {
	raw, err := s.rules.Load()
	if err != nil {
		return nil, fmt.Errorf("load kubeconfig: %w", err)
	}
	if _, ok := raw.Contexts[clusterID]; !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownCluster, clusterID)
	}
	cc := clientcmd.NewNonInteractiveClientConfig(*raw, clusterID, &clientcmd.ConfigOverrides{}, s.rules)
	cfg, err := cc.ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("client config for %q: %w", clusterID, err)
	}
	return cfg, nil
}
