package settings

import (
	"encoding/json"
	"fmt"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

// ValidatePreferences validates known fields without removing future properties.
func ValidatePreferences(raw json.RawMessage) error {
	invalid := func(field, message string) error {
		return &protocol.ErrorDetail{Code: protocol.ErrorCodeInvalid, Message: "Invalid app preferences", Causes: []protocol.ErrorCause{{Field: field, Message: message}}}
	}
	object := func(value json.RawMessage) (map[string]json.RawMessage, bool) {
		var fields map[string]json.RawMessage
		err := json.Unmarshal(value, &fields)
		return fields, err == nil && fields != nil
	}
	root, ok := object(raw)
	if !ok {
		return invalid("value", "Expected a version-1 object")
	}
	var version int
	if json.Unmarshal(root["version"], &version) != nil || version != 1 {
		return invalid("version", "Expected version 1")
	}
	for _, section := range []string{"appearance", "logStreams"} {
		value, exists := root[section]
		if !exists {
			continue
		}
		fields, ok := object(value)
		if !ok {
			return invalid(section, "Expected an object")
		}
		if section == "appearance" {
			if value, exists := fields["theme"]; exists {
				var theme string
				if json.Unmarshal(value, &theme) != nil || (theme != "light" && theme != "dark") {
					return invalid("appearance.theme", "Choose light or dark")
				}
			}
			continue
		}
		for name, maximum := range map[string]int{"maxLines": protocol.PreferenceMaxLines, "maxCharacters": protocol.PreferenceMaxCharacters, "maxDecorations": protocol.PreferenceMaxDecorations} {
			if value, exists := fields[name]; exists {
				var n int
				if string(value) == "null" || json.Unmarshal(value, &n) != nil || n < 1 || n > maximum {
					return invalid("logStreams."+name, fmt.Sprintf("Expected an integer from 1 to %d", maximum))
				}
			}
		}
		for _, name := range []string{"wrap", "timestamps"} {
			if value, exists := fields[name]; exists {
				var b bool
				if string(value) == "null" || json.Unmarshal(value, &b) != nil {
					return invalid("logStreams."+name, "Expected a boolean")
				}
			}
		}
	}
	return nil
}
