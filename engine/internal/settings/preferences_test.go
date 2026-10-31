package settings

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/jimeh/hukube/engine/internal/protocol"
)

func TestValidatePreferences(t *testing.T) {
	for field, maximum := range map[string]int{"maxLines": protocol.PreferenceMaxLines, "maxCharacters": protocol.PreferenceMaxCharacters, "maxDecorations": protocol.PreferenceMaxDecorations} {
		for _, value := range []string{"1", fmt.Sprint(maximum)} {
			raw := json.RawMessage(fmt.Sprintf(`{"version":1,"logStreams":{"%s":%s}}`, field, value))
			if err := ValidatePreferences(raw); err != nil {
				t.Fatalf("accepted bound %s: %v", raw, err)
			}
		}
		for _, value := range []string{"null", "0", fmt.Sprint(maximum + 1), `"1"`, "1.5", "1e100"} {
			raw := json.RawMessage(fmt.Sprintf(`{"version":1,"logStreams":{"%s":%s}}`, field, value))
			if err := ValidatePreferences(raw); err == nil {
				t.Fatalf("invalid bound accepted: %s", raw)
			}
		}
	}

	for _, value := range []string{`{"version":1}`, `{"version":1,"future":{},"appearance":{"theme":"dark","future":1},"logStreams":{"maxLines":1,"maxCharacters":64000000,"maxDecorations":400000,"wrap":false}}`} {
		if err := ValidatePreferences(json.RawMessage(value)); err != nil {
			t.Fatalf("%s: %v", value, err)
		}
	}
	for _, value := range []string{`null`, `{}`, `{"version":2}`, `{"version":1,"appearance":null}`, `{"version":1,"appearance":{"theme":null}}`, `{"version":1,"logStreams":{"wrap":null}}`, `{"version":1,"logStreams":{"maxLines":0}}`, `{"version":1,"logStreams":{"maxLines":100001}}`, `{"version":1,"logStreams":{"maxCharacters":64000001}}`, `{"version":1,"logStreams":{"maxDecorations":400001}}`, `{"version":1,"logStreams":{"maxLines":1.5}}`, `{"version":1,"logStreams":{"maxLines":1e100}}`, `{"version":1,"logStreams":{"timestamps":"true"}}`} {
		if err := ValidatePreferences(json.RawMessage(value)); err == nil {
			t.Fatalf("accepted %s", value)
		}
	}
}

func TestAppPreferencesPersistUnknownFieldsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	value := json.RawMessage(`{"version":1,"appearance":{"theme":"dark"},"future":{"value":42}}`)
	if err := ValidatePreferences(value); err != nil {
		t.Fatal(err)
	}
	empty := ""
	if err := store.CompareAndPut(protocol.AppPreferencesKey, value, &empty); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, revision, err := reopened.Snapshot(protocol.AppPreferencesKey)
	if err != nil || revision == "" || string(got) != string(value) {
		t.Fatalf("reopened preferences=%s revision=%q error=%v", got, revision, err)
	}
}
