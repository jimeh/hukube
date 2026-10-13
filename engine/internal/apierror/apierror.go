// Package apierror preserves Kubernetes error detail on the Engine's protocol.
package apierror

import (
	"context"
	"errors"
	"io"
	"net"

	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

// Detail maps an API or transport error to a structured protocol error.
func Detail(err error) *protocol.ErrorDetail {
	var detail *protocol.ErrorDetail
	if errors.As(err, &detail) {
		return detail
	}
	out := &protocol.ErrorDetail{Code: protocol.ErrorCodeInternal, Message: err.Error(), Causes: []protocol.ErrorCause{}}
	var status apierrors.APIStatus
	var network net.Error
	switch {
	case errors.Is(err, context.Canceled):
		out.Code = protocol.ErrorCodeCancelled
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &network), errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		out.Code = protocol.ErrorCodeUnavailable
	case errors.As(err, &status):
		s := status.Status()
		out.Message, out.Reason = s.Message, string(s.Reason)
		if s.Details != nil {
			for _, c := range s.Details.Causes {
				out.Causes = append(out.Causes, protocol.ErrorCause{Field: c.Field, Reason: string(c.Type), Message: c.Message})
			}
		}
		switch {
		case apierrors.IsForbidden(err), apierrors.IsUnauthorized(err):
			out.Code = protocol.ErrorCodeForbidden
		case apierrors.IsNotFound(err):
			out.Code = protocol.ErrorCodeNotFound
		case apierrors.IsConflict(err):
			out.Code = protocol.ErrorCodeConflict
		case apierrors.IsRequestEntityTooLargeError(err):
			out.Code = protocol.ErrorCodeTooLarge
		case apierrors.IsTimeout(err), apierrors.IsServerTimeout(err), apierrors.IsTooManyRequests(err), s.Code >= 500:
			out.Code = protocol.ErrorCodeUnavailable
		case s.Code >= 400 && s.Code < 500:
			out.Code = protocol.ErrorCodeInvalid
		}
	}
	return out
}
