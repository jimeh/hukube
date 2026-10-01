package notify

import "testing"

// Listener sets for keys that come and go must not accumulate.
func TestKeyedDropsListenerSetsWhenTheirLastListenerStops(t *testing.T) {
	var s Keyed[string]
	_, stopA := s.Subscribe("a", "b")
	_, stopB := s.Subscribe("b")
	_, stopAll := s.Subscribe()

	stopA()
	if _, ok := s.byKey["a"]; ok {
		t.Error(`set for "a" kept after its only listener stopped`)
	}
	if len(s.byKey["b"]) != 1 {
		t.Errorf(`set for "b" has %d listeners, want 1`, len(s.byKey["b"]))
	}
	stopB()
	stopAll()
	stopA()
	if len(s.byKey) != 0 || len(s.all) != 0 {
		t.Errorf("listeners left after every subscription stopped: %v, %v", s.byKey, s.all)
	}
}
