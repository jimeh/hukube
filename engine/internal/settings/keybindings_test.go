package settings

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestValidateKeybindings(t *testing.T) {
	valid := `{"version":1,"rules":[{"id":"user.1","command":"unknown.future","keys":["Mod+K"],"when":"workspace","scope":"app","enabled":true,"args":{"future":[1,true]},"future":true}],"disabledDefaults":["default.resource.app"],"future":{}}`
	if err := ValidateKeybindings(json.RawMessage(valid)); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{
		"version":            strings.Replace(valid, `"version":1`, `"version":2`, 1),
		"scope":              strings.Replace(valid, `"scope":"app"`, `"scope":"global"`, 1),
		"null enabled":       strings.Replace(valid, `"enabled":true`, `"enabled":null`, 1),
		"no strokes":         strings.Replace(valid, `["Mod+K"]`, `[]`, 1),
		"duplicate disables": strings.Replace(valid, `["default.resource.app"]`, `["a","a"]`, 1),
		"large":              valid + strings.Repeat(" ", 65536),
		"args nesting":       strings.Replace(valid, `{"future":[1,true]}`, `{"a":`+strings.Repeat("[", 17)+`0`+strings.Repeat("]", 17)+`}`, 1),
		"null rules":         `{"version":1,"rules":null,"disabledDefaults":[]}`,
	} {
		t.Run(name, func(t *testing.T) {
			if ValidateKeybindings(json.RawMessage(value)) == nil {
				t.Fatal("accepted invalid document")
			}
		})
	}
}

func TestValidateKeybindingsLimits(t *testing.T) {
	makeDocument := func(count int, disabled int) json.RawMessage {
		rules := make([]map[string]any, 0, count)
		for i := 0; i < count; i++ {
			rules = append(rules, map[string]any{"id": fmt.Sprintf("user.%d", i), "command": "app.openSettings", "keys": []string{"Mod+K"}, "when": "", "scope": "app", "enabled": true})
		}
		ids := make([]string, 0, disabled)
		for i := 0; i < disabled; i++ {
			ids = append(ids, fmt.Sprintf("default.%d", i))
		}
		raw, err := json.Marshal(map[string]any{"version": 1, "rules": rules, "disabledDefaults": ids})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	if err := ValidateKeybindings(makeDocument(256, 256)); err != nil {
		t.Fatalf("rejected supported limits: %v", err)
	}
	for _, raw := range []json.RawMessage{makeDocument(257, 0), makeDocument(0, 257)} {
		if err := ValidateKeybindings(raw); err == nil || !strings.Contains(err.Error(), "at most 256") {
			t.Fatalf("count boundary: %v", err)
		}
	}
	raw := makeDocument(0, 0)
	raw = append(raw, []byte(strings.Repeat(" ", 64*1024-len(raw)))...)
	if err := ValidateKeybindings(raw); err != nil {
		t.Fatalf("rejected 64 KiB: %v", err)
	}
	if err := ValidateKeybindings(append(raw, ' ')); err == nil {
		t.Fatal("accepted more than 64 KiB")
	}
}
