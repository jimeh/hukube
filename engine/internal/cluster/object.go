package cluster

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

// objectRetry is how long WatchObject waits before re-listing after an error.
var objectRetry = 2 * time.Second

// WatchObject calls emit with the full Manifest of one Resource, and again
// whenever it changes, until ctx ends. A Resource that does not exist, or is
// deleted, is emitted as Deleted, and emitted again if it is created later.
// Errors from the Cluster are passed to onErr and retried.
func (c *Cluster) WatchObject(ctx context.Context, ref protocol.ResourceRef, emit func(protocol.ResourceData), onErr func(error)) error {
	t, err := c.lookup(ref.Type)
	if err != nil {
		return err
	}
	var client dynamic.ResourceInterface = c.dyn.Resource(t.gvr)
	if t.info.Namespaced {
		client = c.dyn.Resource(t.gvr).Namespace(ref.Namespace)
	}
	selector := fields.OneTermEqualSelector("metadata.name", ref.Name).String()

	go func() {
		for ctx.Err() == nil {
			if err := watchObjectOnce(ctx, client, selector, emit); err != nil && ctx.Err() == nil {
				onErr(err)
				select {
				case <-ctx.Done():
				case <-time.After(objectRetry):
				}
			}
		}
	}()
	return nil
}

// watchObjectOnce lists the object, emits it, then follows its watch until the
// watch ends.
func watchObjectOnce(ctx context.Context, client dynamic.ResourceInterface, selector string, emit func(protocol.ResourceData)) error {
	list, err := client.List(ctx, metav1.ListOptions{FieldSelector: selector})
	if err != nil {
		return err
	}
	if len(list.Items) == 0 {
		emit(protocol.ResourceData{Deleted: true})
	} else if err := emitObject(&list.Items[0], emit); err != nil {
		return err
	}

	w, err := client.Watch(ctx, metav1.ListOptions{
		FieldSelector:   selector,
		ResourceVersion: list.GetResourceVersion(),
	})
	if err != nil {
		return err
	}
	defer w.Stop()
	for ev := range w.ResultChan() {
		switch ev.Type {
		case watch.Added, watch.Modified:
			obj, ok := ev.Object.(*unstructured.Unstructured)
			if !ok {
				continue
			}
			if err := emitObject(obj, emit); err != nil {
				return err
			}
		case watch.Deleted:
			emit(protocol.ResourceData{Deleted: true})
		case watch.Error:
			err := apierrors.FromObject(ev.Object)
			if apierrors.IsResourceExpired(err) || apierrors.IsGone(err) {
				// The watch fell too far behind; re-list without reporting it.
				return nil
			}
			return fmt.Errorf("watch: %w", err)
		}
	}
	return nil
}

func emitObject(obj *unstructured.Unstructured, emit func(protocol.ResourceData)) error {
	raw, err := json.Marshal(obj.Object)
	if err != nil {
		return err
	}
	emit(protocol.ResourceData{Object: raw})
	return nil
}
