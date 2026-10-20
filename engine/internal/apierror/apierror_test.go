package apierror

import (
	"errors"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

func TestReadablePatchCauses(t *testing.T) {
	payload := strconv.Quote(strings.Repeat("x", 201))
	detail := &protocol.ErrorDetail{
		Code: protocol.ErrorCodeInvalid, Message: "payload " + payload, Reason: "Invalid",
		Causes: []protocol.ErrorCause{{Field: "patch", Message: "Invalid value: " + payload + `: strict decoding error: unknown field "spec.bogusField", duplicate field "spec.replicas"`}},
	}
	got := Detail(detail)
	want := []protocol.ErrorCause{{Field: "spec.bogusField", Message: "unknown field"}, {Field: "spec.replicas", Message: "duplicate field"}}
	if !reflect.DeepEqual(got.Causes, want) || got.Message != "spec.bogusField: unknown field; spec.replicas: duplicate field" {
		t.Fatalf("unreadable detail: %+v, causes: %+v", got, got.Causes)
	}
	if detail.Message != "payload "+payload {
		t.Fatal("mapping changed its input")
	}
}

func TestMessageBounds(t *testing.T) {
	message := strings.Repeat("界", 1001)
	for _, err := range []error{errors.New(message), &protocol.ErrorDetail{Message: message, Causes: []protocol.ErrorCause{{Message: message}}}} {
		got := Detail(err)
		if utf8.RuneCountInString(got.Message) != 1000 || !strings.HasSuffix(got.Message, "…") {
			t.Fatal("message was not bounded")
		}
		for _, cause := range got.Causes {
			if utf8.RuneCountInString(cause.Message) != 1000 || !strings.HasSuffix(cause.Message, "…") {
				t.Fatal("cause was not bounded")
			}
		}
	}
}
