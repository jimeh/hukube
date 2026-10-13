// Package apierror preserves Kubernetes error detail on the Engine's protocol.
package apierror

import (
	"context"
	"errors"
	"io"
	"net"
	"regexp"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

// Detail maps an API or transport error to a structured protocol error.
func Detail(err error) *protocol.ErrorDetail {
	var detail *protocol.ErrorDetail
	if errors.As(err, &detail) {
		return readable(detail)
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
	return readable(out)
}

var invalidValue = regexp.MustCompile(`^Invalid value: ("(?:\\.|[^"\\])*"): (.*)$`)
var strictField = regexp.MustCompile(`(unknown|duplicate) field "((?:\\.|[^"\\])*)"`)
var wrongType = regexp.MustCompile(`^json: cannot unmarshal (.+) into Go struct field [^.]+\.(.+) of type (.+)$`)

// API patch failures can quote the whole Resource before the useful detail.
func readable(detail *protocol.ErrorDetail) *protocol.ErrorDetail {
	out := *detail
	out.Causes = make([]protocol.ErrorCause, 0, len(detail.Causes))
	rewritten := false
	for _, cause := range detail.Causes {
		original := cause.Message
		if parts := invalidValue.FindStringSubmatch(cause.Message); len(parts) != 0 && len(parts[1]) > 200 {
			cause.Message = parts[2]
		}
		if cause.Field == "patch" && strings.HasPrefix(cause.Message, "strict decoding error: ") {
			problems := strings.TrimPrefix(cause.Message, "strict decoding error: ")
			matches := strictField.FindAllStringSubmatch(problems, -1)
			if len(matches) > 0 && strings.Trim(strictField.ReplaceAllString(problems, ""), ", ") == "" {
				for _, match := range matches {
					out.Causes = append(out.Causes, protocol.ErrorCause{Field: match[2], Reason: cause.Reason, Message: match[1] + " field"})
				}
				rewritten = true
				continue
			}
		}
		if cause.Field == "patch" {
			if parts := wrongType.FindStringSubmatch(cause.Message); len(parts) != 0 {
				cause.Field = parts[2]
				cause.Message = "expected " + parts[3] + ", got " + parts[1]
			}
		}
		rewritten = rewritten || original != cause.Message
		cause.Message = bounded(cause.Message)
		out.Causes = append(out.Causes, cause)
	}
	if rewritten {
		messages := make([]string, 0, len(out.Causes))
		for _, cause := range out.Causes {
			message := cause.Message
			if cause.Field != "" {
				message = cause.Field + ": " + message
			}
			messages = append(messages, message)
		}
		out.Message = strings.Join(messages, "; ")
	}
	out.Message = bounded(out.Message)
	return &out
}

func bounded(message string) string {
	if len(message) <= 1000 {
		return message
	}
	chars := []rune(message)
	if len(chars) <= 1000 {
		return message
	}
	return string(chars[:999]) + "…"
}
