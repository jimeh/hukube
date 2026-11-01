package settings

import (
	"encoding/json"
	"fmt"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

// ValidateKeybindings bounds the wire shape, retaining future fields. The UI
// owns command semantics. Unknown commands cannot bypass these storage limits.
func ValidateKeybindings(raw json.RawMessage) error {
	invalid := func(message string) error {
		return &protocol.ErrorDetail{Code: protocol.ErrorCodeInvalid, Message: "Invalid keybindings: " + message}
	}
	if len(raw) > 64*1024 {
		return invalid("document exceeds 64 KiB")
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(raw, &root) != nil || root == nil {
		return invalid("expected an object")
	}
	if string(root["version"]) != "1" {
		return invalid("expected version 1")
	}
	var rules []map[string]json.RawMessage
	if json.Unmarshal(root["rules"], &rules) != nil || rules == nil || len(rules) > 256 {
		return invalid("expected at most 256 rules")
	}
	boundedString := func(raw json.RawMessage, max int) (string, bool) {
		var s string
		err := json.Unmarshal(raw, &s)
		return s, err == nil && string(raw) != "null" && len(s) <= max
	}
	ids := map[string]bool{}
	for _, r := range rules {
		id, ok := boundedString(r["id"], 128)
		if !ok || id == "" || ids[id] {
			return invalid("unique non-empty stable rule IDs required")
		}
		ids[id] = true
		cmd, ok := boundedString(r["command"], 128)
		if !ok || cmd == "" {
			return invalid("command required")
		}
		if _, ok := boundedString(r["when"], 1024); !ok {
			return invalid("condition exceeds 1 KiB or is not a string")
		}
		scope, ok := boundedString(r["scope"], 16)
		if !ok || (scope != "app" && scope != "terminal") {
			return invalid("scope must be app or terminal")
		}
		var enabled bool
		if string(r["enabled"]) == "null" || json.Unmarshal(r["enabled"], &enabled) != nil {
			return invalid("enabled must be boolean")
		}
		var keys []string
		if json.Unmarshal(r["keys"], &keys) != nil || len(keys) < 1 || len(keys) > 2 {
			return invalid("one or two strokes required")
		}
		for _, key := range keys {
			if len(key) == 0 || len(key) > 100 {
				return invalid("invalid stroke length")
			}
		}
		if args, ok := r["args"]; ok {
			var value map[string]any
			if len(args) > 16*1024 || json.Unmarshal(args, &value) != nil || value == nil {
				return invalid("args must be an object of at most 16 KiB")
			}
			var bounded func(any, int) bool
			bounded = func(v any, depth int) bool {
				if depth > 16 {
					return false
				}
				switch x := v.(type) {
				case map[string]any:
					for k, v := range x {
						if len(k) > 128 || !bounded(v, depth+1) {
							return false
						}
					}
				case []any:
					for _, v := range x {
						if !bounded(v, depth+1) {
							return false
						}
					}
				}
				return true
			}
			if !bounded(value, 0) {
				return invalid("args exceed depth 16")
			}
		}
	}
	var disabled []string
	if json.Unmarshal(root["disabledDefaults"], &disabled) != nil || disabled == nil || len(disabled) > 256 {
		return invalid("expected at most 256 disabled defaults")
	}
	ids = map[string]bool{}
	for _, id := range disabled {
		if id == "" || len(id) > 128 || ids[id] {
			return invalid(fmt.Sprintf("invalid or duplicate disabled default %q", id))
		}
		ids[id] = true
	}
	return nil
}
