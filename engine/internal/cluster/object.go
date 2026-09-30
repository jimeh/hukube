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

// WatchObject calls emit with the full Manifest of one Resource, and again
// whenever it changes, until ctx ends. A Resource that does not exist, or is
// deleted, is emitted as Deleted, and emitted again if it is created later.
//
// It waits for the Resource Type to be discovered, so subscriptions made
// while the Cluster is still connecting succeed, and it re-resolves the type
// on every retry, so it follows a change of preferred API version. Errors,
// including a type the connected Cluster does not serve, are passed to onErr
// and retried after Timing.ObjectRetry; so is a watch that ended almost as
// soon as it started.
func (c *Cluster) WatchObject(ctx context.Context, ref protocol.ResourceRef, emit func(protocol.ResourceData), onErr func(error)) {
	selector := fields.OneTermEqualSelector("metadata.name", ref.Name).String()
	go func() {
		for ctx.Err() == nil {
			client, err := c.objectClient(ctx, ref, onErr)
			if err != nil {
				return
			}
			started := time.Now()
			err = watchObjectOnce(ctx, client, selector, emit)
			if ctx.Err() != nil {
				return
			}
			if err != nil {
				onErr(err)
			} else if time.Since(started) >= c.timing.ObjectRetry {
				continue
			}
			select {
			case <-ctx.Done():
			case <-time.After(c.timing.ObjectRetry):
			}
		}
	}()
}

// objectClient waits until ref's type is discovered and returns a client for
// it. Once the Cluster is ready, a type it does not serve is reported through
// onErr while waiting for it to appear. It returns an error only when ctx ends.
func (c *Cluster) objectClient(ctx context.Context, ref protocol.ResourceRef, onErr func(error)) (dynamic.ResourceInterface, error) {
	// Discovery finishes before the Cluster becomes ready, so wake on either
	// signal. Subscribe before checking, so no change is missed in between.
	typesChanged, stopTypes := c.typesChanged.Subscribe()
	defer stopTypes()
	statusChanged, stopStatus := c.statusChanged.Subscribe()
	defer stopStatus()
	reported := false
	for {
		if gvr, namespaced, ok := c.resolve(ref.Type); ok {
			if namespaced {
				return c.dyn.Resource(gvr).Namespace(ref.Namespace), nil
			}
			return c.dyn.Resource(gvr), nil
		}
		if !reported && c.Status().Phase == protocol.ClusterPhaseReady {
			onErr(fmt.Errorf("%w: %q", ErrUnknownType, ref.Type))
			reported = true
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-typesChanged:
		case <-statusChanged:
		}
	}
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
