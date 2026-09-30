// Package testenv runs a real kube-apiserver and etcd for integration tests,
// using controller-runtime's envtest.
package testenv

import (
	"fmt"
	"os"
	"testing"

	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/envtest"

	"github.com/jimeh/hukube/engine/internal/kubeconfig"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

// ClusterID is the ID of the single Cluster served by Source.
const ClusterID = "envtest"

// Run starts an API server, stores its config in *cfg, runs the package's
// tests, and stops the server. Without KUBEBUILDER_ASSETS it skips the
// package's tests locally but fails in CI, so a misconfigured pipeline cannot
// silently drop integration coverage. Use it from TestMain.
func Run(m *testing.M, cfg **rest.Config) int {
	if os.Getenv("KUBEBUILDER_ASSETS") == "" {
		if os.Getenv("CI") != "" {
			fmt.Fprintln(os.Stderr, "KUBEBUILDER_ASSETS is not set; run tests with `mise run test:engine`")
			return 1
		}
		fmt.Fprintln(os.Stderr, "skipping envtest integration tests: KUBEBUILDER_ASSETS is not set (use `mise run test:engine`)")
		return 0
	}

	env := &envtest.Environment{}
	c, err := env.Start()
	if err != nil {
		fmt.Fprintln(os.Stderr, "start envtest:", err)
		return 1
	}
	*cfg = c
	code := m.Run()
	if err := env.Stop(); err != nil {
		fmt.Fprintln(os.Stderr, "stop envtest:", err)
	}
	return code
}

// Source serves one Cluster, ClusterID, backed by cfg.
type Source struct {
	Config *rest.Config
}

var _ kubeconfig.Source = Source{}

func (s Source) Clusters() ([]protocol.Cluster, error) {
	return []protocol.Cluster{{ID: ClusterID, Server: s.Config.Host, Current: true}}, nil
}

func (s Source) RESTConfig(id string) (*rest.Config, error) {
	if id != ClusterID {
		return nil, fmt.Errorf("%w: %q", kubeconfig.ErrUnknownCluster, id)
	}
	return s.Config, nil
}
