package cluster

import (
	"context"
	"net/http"

	authv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
	"k8s.io/streaming/pkg/httpstream"

	"github.com/jimeh/hukube/engine/internal/execsession"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

func execFallback(err error) bool {
	return httpstream.IsUpgradeFailure(err) || httpstream.IsHTTPSProxyError(err)
}

// Exec builds an executor whose lifetime is controlled by the session.
func (c *Cluster) Exec(p protocol.ExecParams) (execsession.Executor, error) {
	command := p.Command
	if len(command) == 0 {
		command = []string{"sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"}
	}
	url := c.logs.RESTClient().Post().Resource("pods").Namespace(p.Namespace).Name(p.Pod).SubResource("exec").VersionedParams(&corev1.PodExecOptions{Container: p.Container, Command: command, Stdin: true, Stdout: true, TTY: true}, scheme.ParameterCodec).URL()
	primary, err := remotecommand.NewWebSocketExecutor(c.execConfig, http.MethodGet, url.String())
	if err != nil {
		return nil, err
	}
	secondary, err := remotecommand.NewSPDYExecutor(c.execConfig, http.MethodPost, url)
	if err != nil {
		return nil, err
	}
	return remotecommand.NewFallbackExecutor(primary, secondary, execFallback)
}

// ReadPod reads the current status to distinguish an exit from a stopped container.
func (c *Cluster) ReadPod(ctx context.Context, namespace, name string) (*corev1.Pod, error) {
	return c.core.Pods(namespace).Get(ctx, name, metav1.GetOptions{})
}

// ExecAccess checks create on pods/exec, independently of discovered Pod verbs.
func (c *Cluster) ExecAccess(ctx context.Context, namespace, name string) (protocol.Access, error) {
	key := accessKey{resource: schema.GroupVersionResource{Version: "v1", Resource: "pods"}, namespace: namespace, name: name, verb: "create", subresource: "exec"}
	return c.checkAccess(ctx, key, "opening an Exec Session in", &authv1.ResourceAttributes{Namespace: namespace, Verb: "create", Version: "v1", Resource: "pods", Subresource: "exec", Name: name})
}
