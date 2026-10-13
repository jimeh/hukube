package cluster

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	authv1 "k8s.io/api/authorization/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"

	"github.com/jimeh/hukube/engine/internal/apierror"
	"github.com/jimeh/hukube/engine/internal/edit"
	"github.com/jimeh/hukube/engine/internal/protocol"
)

type warningKey struct{}
type warnings struct {
	mu     sync.Mutex
	values []string
}
type warningHandler struct{}

func (warningHandler) HandleWarningHeaderWithContext(ctx context.Context, code int, _ string, text string) {
	if code != 299 {
		return
	}
	if w, ok := ctx.Value(warningKey{}).(*warnings); ok {
		w.mu.Lock()
		w.values = append(w.values, text)
		w.mu.Unlock()
	}
}
func (w *warnings) snapshot() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string{}, w.values...)
}

// requestType waits for initial discovery, but does not wait for an unknown type to appear.
func (c *Cluster) requestType(ctx context.Context, key protocol.TypeKey) (protocol.ResourceType, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var unknown error
	info, err := c.waitForType(ctx, key, func(err error) { unknown = err; cancel() })
	if unknown != nil {
		return info, unknown
	}
	return info, err
}

func resourceClient(client dynamic.Interface, info protocol.ResourceType, namespace string) dynamic.ResourceInterface {
	gvr := schema.GroupVersionResource{Group: info.Group, Version: info.Version, Resource: info.Resource}
	if info.Namespaced {
		return client.Resource(gvr).Namespace(namespace)
	}
	return client.Resource(gvr)
}

func (c *Cluster) editLive(ctx context.Context, p protocol.ResourceEdit, client dynamic.ResourceInterface) (*unstructured.Unstructured, error) {
	live, err := client.Get(ctx, p.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		detail := apierror.Detail(err)
		detail.Message = "The Resource was deleted from the Cluster."
		return nil, detail
	}
	if err != nil {
		return nil, err
	}
	if p.UID == "" {
		return nil, &protocol.ErrorDetail{Code: protocol.ErrorCodeInvalid, Message: "Editing a Resource requires its UID."}
	}
	if string(live.GetUID()) != p.UID {
		return nil, &protocol.ErrorDetail{Code: protocol.ErrorCodeNotFound, Message: "The Resource was replaced by a Resource of the same name."}
	}
	return live, nil
}

// Review compares an edit with the latest Resource and asks for a dry run.
func (c *Cluster) Review(ctx context.Context, p protocol.ResourceEdit) (protocol.EditReview, error) {
	r, _, err := c.runEdit(ctx, p, false)
	return r, err
}

// Apply sends only the effective edit, refusing unreviewed concurrent changes.
func (c *Cluster) Apply(ctx context.Context, p protocol.ResourceEdit) (protocol.ApplyResult, error) {
	_, r, err := c.runEdit(ctx, p, true)
	return r, err
}

func (c *Cluster) runEdit(ctx context.Context, p protocol.ResourceEdit, apply bool) (protocol.EditReview, protocol.ApplyResult, error) {
	info, err := c.requestType(ctx, p.Type)
	if err != nil {
		return protocol.EditReview{}, protocol.ApplyResult{}, err
	}
	reads, writes := resourceClient(c.dyn, info, p.Namespace), resourceClient(c.writes, info, p.Namespace)
	w := &warnings{values: []string{}}
	ctx = context.WithValue(ctx, warningKey{}, w)
	for range 5 {
		if err := ctx.Err(); err != nil {
			return protocol.EditReview{}, protocol.ApplyResult{}, err
		}
		live, err := c.editLive(ctx, p, reads)
		if err != nil {
			return protocol.EditReview{}, protocol.ApplyResult{}, err
		}
		raw, err := json.Marshal(live.Object)
		if err != nil {
			return protocol.EditReview{}, protocol.ApplyResult{}, err
		}
		comparison, err := edit.Compare(p.Base, p.Manifest, raw)
		if err != nil {
			return protocol.EditReview{}, protocol.ApplyResult{}, &protocol.ErrorDetail{Code: protocol.ErrorCodeInvalid, Message: "Invalid Manifest: " + err.Error()}
		}
		r := comparison.Review
		r.Warnings = w.snapshot()
		if apply && len(p.Expected) > 0 {
			expected, err := edit.Editable(p.Expected)
			if err != nil {
				return r, protocol.ApplyResult{}, &protocol.ErrorDetail{Code: protocol.ErrorCodeInvalid, Message: "Invalid expected Manifest: " + err.Error()}
			}
			if edit.Equal(r.Before, expected) {
				return r, protocol.ApplyResult{ResourceVersion: live.GetResourceVersion(), Unchanged: true, Warnings: w.snapshot()}, nil
			}
		}
		if apply && len(r.Overlaps) > 0 {
			return r, protocol.ApplyResult{}, &protocol.ErrorDetail{Code: protocol.ErrorCodeConflict, Message: "The Resource changed on the Cluster. Review the edit again before applying it."}
		}
		if r.Refusal != nil {
			if apply {
				return r, protocol.ApplyResult{}, r.Refusal
			}
			return r, protocol.ApplyResult{}, nil
		}
		if len(r.Edited) == 0 {
			r.After = r.Desired
			return r, protocol.ApplyResult{ResourceVersion: live.GetResourceVersion(), Unchanged: true, Warnings: w.snapshot()}, nil
		}
		patch, err := edit.WithVersion(comparison.Effective, live.GetResourceVersion())
		if err != nil {
			return r, protocol.ApplyResult{}, err
		}
		options := metav1.PatchOptions{FieldManager: "hukube", FieldValidation: metav1.FieldValidationStrict}
		patchCtx := ctx
		cancel := func() {}
		if apply {
			// Before this point cancellation means no write. Once sent, the write finishes.
			if err := ctx.Err(); err != nil {
				return r, protocol.ApplyResult{}, err
			}
			patchCtx, cancel = context.WithTimeout(context.WithoutCancel(ctx), c.timing.WriteTimeout)
		} else {
			options.DryRun = []string{metav1.DryRunAll}
		}
		after, err := writes.Patch(patchCtx, p.Name, types.MergePatchType, patch, options)
		cancel()
		if apierrors.IsConflict(err) {
			continue
		}
		r.Warnings = w.snapshot()
		if err != nil {
			if !apply && ctx.Err() != nil {
				return r, protocol.ApplyResult{}, ctx.Err()
			}
			if apply {
				return r, protocol.ApplyResult{}, writeError(err)
			}
			r.Refusal = apierror.Detail(err)
			r.DryRunUnsupported = apierrors.IsBadRequest(err) && strings.Contains(err.Error(), "does not support dry run")
			return r, protocol.ApplyResult{}, nil
		}
		if apply {
			return r, protocol.ApplyResult{ResourceVersion: after.GetResourceVersion(), Warnings: w.snapshot()}, nil
		}
		raw, err = json.Marshal(after.Object)
		if err != nil {
			return r, protocol.ApplyResult{}, err
		}
		r.After, err = edit.Editable(raw)
		if err != nil {
			return r, protocol.ApplyResult{}, err
		}
		delta, err := edit.Diff(r.Desired, r.After)
		if err != nil {
			return r, protocol.ApplyResult{}, err
		}
		r.SetByCluster = edit.Paths(delta)
		return r, protocol.ApplyResult{}, nil
	}
	code := protocol.ErrorCodeUnavailable
	if apply {
		code = protocol.ErrorCodeConflict
	}
	return protocol.EditReview{}, protocol.ApplyResult{}, &protocol.ErrorDetail{Code: code, Message: "The Resource kept changing on the Cluster. Review the edit again."}
}

// Delete addresses a Resource incarnation, so a repeat cannot delete its replacement.
func (c *Cluster) Delete(ctx context.Context, p protocol.DeleteParams) error {
	if p.UID == "" {
		return &protocol.ErrorDetail{Code: protocol.ErrorCodeInvalid, Message: "Deleting a Resource requires its UID."}
	}
	var policy metav1.DeletionPropagation
	switch p.Propagation {
	case "", protocol.DeletePropagationBackground:
		policy = metav1.DeletePropagationBackground
	case protocol.DeletePropagationForeground:
		policy = metav1.DeletePropagationForeground
	case protocol.DeletePropagationOrphan:
		policy = metav1.DeletePropagationOrphan
	default:
		return &protocol.ErrorDetail{Code: protocol.ErrorCodeInvalid, Message: "Unknown delete propagation policy."}
	}
	info, err := c.requestType(ctx, p.Type)
	if err != nil {
		return err
	}
	uid := types.UID(p.UID)
	options := metav1.DeleteOptions{PropagationPolicy: &policy, Preconditions: &metav1.Preconditions{UID: &uid}}
	if p.Immediate && p.Type == "pods" {
		zero := int64(0)
		options.GracePeriodSeconds = &zero
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.timing.WriteTimeout)
	defer cancel()
	err = resourceClient(c.writes, info, p.Namespace).Delete(writeCtx, p.Name, options)
	if apierrors.IsNotFound(err) {
		return nil
	}
	if apierrors.IsConflict(err) {
		detail := apierror.Detail(err)
		detail.Message = "The Resource was replaced by a Resource of the same name. Nothing was deleted."
		return detail
	}
	return writeError(err)
}

// Without an API answer, a sent write's outcome is unknown.
func writeError(err error) error {
	if err == nil {
		return nil
	}
	var status apierrors.APIStatus
	var detail *protocol.ErrorDetail
	if errors.As(err, &status) || errors.As(err, &detail) {
		return err
	}
	return &protocol.ErrorDetail{Code: protocol.ErrorCodeUnavailable, Message: err.Error(), Causes: []protocol.ErrorCause{}}
}

type accessKey struct {
	resource              schema.GroupVersionResource
	namespace, name, verb string
}
type cachedAccess struct {
	access protocol.Access
	until  time.Time
}

// Access checks discovered verbs and the credentials' access to the named Resource.
func (c *Cluster) Access(ctx context.Context, ref protocol.ResourceRef) (protocol.ResourceAccess, error) {
	info, err := c.requestType(ctx, ref.Type)
	if err != nil {
		return protocol.ResourceAccess{}, err
	}
	check := func(verb, action string) (protocol.Access, error) {
		if !slices.Contains(info.Verbs, verb) {
			return protocol.Access{Reason: fmt.Sprintf("The Cluster does not support %s this Resource Type.", action)}, nil
		}
		key := accessKey{resource: schema.GroupVersionResource{Group: info.Group, Version: info.Version, Resource: info.Resource}, namespace: ref.Namespace, name: ref.Name, verb: verb}
		c.accessMu.Lock()
		cached, ok := c.access[key]
		c.accessMu.Unlock()
		if ok && time.Now().Before(cached.until) {
			return cached.access, ctx.Err()
		}
		review, err := c.auth.SelfSubjectAccessReviews().Create(ctx, &authv1.SelfSubjectAccessReview{Spec: authv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authv1.ResourceAttributes{Namespace: ref.Namespace, Verb: verb, Group: info.Group, Version: info.Version, Resource: info.Resource, Name: ref.Name}}}, metav1.CreateOptions{})
		if ctx.Err() != nil {
			return protocol.Access{}, ctx.Err()
		}
		access := protocol.Access{Allowed: true}
		if err == nil && !review.Status.Allowed && (review.Status.Denied || review.Status.EvaluationError == "") {
			access = protocol.Access{Reason: fmt.Sprintf("Your Cluster credentials do not permit %s this Resource.", action)}
			if review.Status.Reason != "" {
				access.Reason += " " + review.Status.Reason
			}
		}
		c.accessMu.Lock()
		now := time.Now()
		for key, cached := range c.access {
			if !now.Before(cached.until) {
				delete(c.access, key)
			}
		}
		c.access[key] = cachedAccess{access: access, until: now.Add(c.timing.AccessCache)}
		c.accessMu.Unlock()
		return access, nil
	}
	e, err := check("patch", "editing")
	if err != nil {
		return protocol.ResourceAccess{}, err
	}
	d, err := check("delete", "deleting")
	return protocol.ResourceAccess{Edit: e, Delete: d}, err
}
