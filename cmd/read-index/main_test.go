package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultsKeepWhatTheListenerSet(t *testing.T) {
	data := t.TempDir()
	library := filepath.Join(t.TempDir(), "local", "index.json")
	setLibraryDefault(library)
	if err := writeDefaults(data, false); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(data, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]string
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{
		"library": library, "endpoint": "https://lrclib.net",
		"cacheHours": "168", "timeoutMs": "8000", "writeLrc": "true",
		"syncLimit": "25", "syncIntervalMinutes": "15",
	} {
		if strings.ReplaceAll(got[key], `\`, "/") != strings.ReplaceAll(want, `\`, "/") {
			t.Errorf("%s = %q, want %q", key, got[key], want)
		}
	}
	settings := map[string]string{"endpoint": "https://mine.example", "writeLrc": "false"}
	raw, _ := json.Marshal(settings)
	if err := os.WriteFile(filepath.Join(data, "settings.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeDefaults(data, false); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(filepath.Join(data, "settings.json"))
	json.Unmarshal(b, &got)
	if got["endpoint"] != "https://mine.example" || got["writeLrc"] != "false" {
		t.Errorf("listener's settings were overwritten: %v", got)
	}
	if got["timeoutMs"] != "8000" {
		t.Errorf("a missing default wasn't filled: %v", got)
	}
}

func TestSidecarNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	song := filepath.Join(dir, "Song.mp3")
	if err := os.WriteFile(song, []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := writeSidecar(sidecar{song, "[00:01.00] First"}); got != "written" {
		t.Fatalf("first write = %q", got)
	}
	if got := writeSidecar(sidecar{song, "[00:02.00] Second"}); got != "skipped" {
		t.Errorf("second write = %q", got)
	}
	b, err := os.ReadFile(filepath.Join(dir, "Song.lrc"))
	if err != nil || string(b) != "[00:01.00] First" {
		t.Errorf("existing .lrc = %q, %v", b, err)
	}
	if got := writeSidecar(sidecar{filepath.Join(dir, "Gone.mp3"), "words"}); got != "skipped" {
		t.Errorf("missing song = %q", got)
	}
}

func TestGuessNamesFromFilename(t *testing.T) {
	for _, tc := range []struct{ path, artist, title string }{
		{"/Music/Radiohead - Creep.mp3", "Radiohead", "Creep"},
		{"/Music/宋冬野-鸽子.mp3", "宋冬野", "鸽子"},
		{"/Music/Creep.mp3", "", "Creep"},
	} {
		a, title := guessNames(tc.path)
		if a != tc.artist || title != tc.title {
			t.Errorf("%s = %q / %q, want %q / %q", tc.path, a, title, tc.artist, tc.title)
		}
	}
}
