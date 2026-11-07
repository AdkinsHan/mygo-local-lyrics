// read-index reads MyGo Music's local library index and answers a compact JSON
// list, one row per song. It is the only program the plugin starts, and it only
// touches the files it is given.
//
//   read-index <local/index.json>   print the library as one JSON line
//   read-index sync                 read {"path","lrc"} lines on stdin and
//                                  write .lrc beside each song that has none
//
// The app's built-in Local Files source reads a .lrc beside a song by itself,
// so writing those files is what makes LRCLib lyrics show while the listener
// plays from Local Files, where the app never asks the plugin for lyrics.

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type entry struct {
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Title    string `json:"title"`
	Artist   string `json:"artist"`
	Album    string `json:"album"`
	Duration int64  `json:"duration"` // milliseconds
	Cover    string `json:"cover"`
}

type row struct {
	ID       string `json:"id"`
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Title    string `json:"title"`
	Artist   string `json:"artist"`
	Album    string `json:"album"`
	Duration int64  `json:"duration"`
	Cover    string `json:"cover"`
}

// trackID names a track the way the app's local source does.
func trackID(path string) string {
	sum := sha256.Sum256([]byte("track\x00" + path))
	return hex.EncodeToString(sum[:8])
}

func baseName(path string) string {
	path = strings.ReplaceAll(path, `\`, "/")
	name := path[strings.LastIndex(path, "/")+1:]
	if i := strings.LastIndex(name, "."); i > 0 {
		name = name[:i]
	}
	return name
}

// guessNames reads the "Artist - Title" (or "Artist-Title") many ripped files
// are named by. It only fills what the index left out, so a tagged song keeps
// its tags. deriveTitle is checked against the real title before an artist is
// guessed, so a title like "Creep - Live" doesn't become artist "Creep".
func guessNames(path string) (artist, title string) {
	name := baseName(path)
	if i := strings.Index(name, " - "); i > 0 {
		return strings.TrimSpace(name[:i]), strings.TrimSpace(name[i+3:])
	}
	if i := strings.IndexByte(name, '-'); i > 0 {
		a, b := strings.TrimSpace(name[:i]), strings.TrimSpace(name[i+1:])
		if a != "" && b != "" {
			return a, b
		}
	}
	return "", name
}

func readIndex(path string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var index struct {
		Tracks []entry `json:"tracks"`
	}
	if err := json.Unmarshal(b, &index); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	out := make([]row, 0, len(index.Tracks))
	for _, e := range index.Tracks {
		if e.Path == "" {
			continue
		}
		title := e.Title
		artist := e.Artist
		guessArtist, guessTitle := guessNames(e.Path)
		if strings.TrimSpace(title) == "" {
			title = guessTitle
		}
		if strings.TrimSpace(artist) == "" && strings.EqualFold(guessTitle, title) {
			artist = guessArtist
		}
		out = append(out, row{
			ID:       trackID(e.Path),
			Path:     e.Path,
			Size:     e.Size,
			Title:    title,
			Artist:   artist,
			Album:    e.Album,
			Duration: e.Duration,
			Cover:    e.Cover,
		})
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	return enc.Encode(out)
}

type sidecar struct {
	Path string `json:"path"`
	LRC  string `json:"lrc"`
}

// defaults are the values the Settings > Plugins page shows for an untouched
// plugin. The app's Setting has no default of its own, so the helper fills
// only the keys the listener hasn't set, and leaves what they did set alone.
// defaults are what the installer writes into the app's settings.json, so
// every Settings > Plugins box has a real value on first install. The plugin
// itself also falls back to these when a key is missing or blank.
var libraryDefault string

func setLibraryDefault(path string) { libraryDefault = filepath.ToSlash(path) }

func defaultSettings() map[string]string {
	return map[string]string{
		"library":             libraryDefault,
		"endpoint":            "https://lrclib.net",
		"cacheHours":          "168",
		"timeoutMs":           "8000",
		"writeLrc":            "true",
		"syncLimit":           "25",
		"syncIntervalMinutes": "15",
	}
}

// writeDefaults writes the plugin's settings.json. It only adds keys that
// aren't there at all, so the listener's own edits stay. With force, the
// installer fills every key afresh.
func writeDefaults(dataDir string, force bool) error {
	path := filepath.Join(dataDir, "settings.json")
	settings := map[string]string{}
	if !force {
		if b, err := os.ReadFile(path); err == nil {
			_ = json.Unmarshal(b, &settings)
		}
	}
	if settings == nil {
		settings = map[string]string{}
	}
	if force {
		// A development install replaces the whole settings file, so keys
		// from an older version don't linger in the app's data.
		settings = defaultSettings()
	} else {
		for key, value := range defaultSettings() {
			if _, ok := settings[key]; !ok {
				settings[key] = value
			}
		}
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// writeSidecar keeps a lyric beside its song, if the song is there and the
// listener hasn't got a .lrc of their own. It never overwrites one.
func writeSidecar(s sidecar) string {
	if s.Path == "" || strings.TrimSpace(s.LRC) == "" {
		return "skipped"
	}
	info, err := os.Stat(s.Path)
	if err != nil || !info.Mode().IsRegular() {
		return "skipped"
	}
	base := strings.TrimSuffix(s.Path, filepath.Ext(s.Path))
	for _, ext := range []string{".lrc", ".LRC"} {
		if _, err := os.Stat(base + ext); err == nil {
			return "skipped"
		}
	}
	target := base + ".lrc"
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, []byte(s.LRC), 0o644); err != nil {
		return "failed"
	}
	if err := os.Rename(tmp, target); err != nil {
		os.Remove(tmp)
		return "failed"
	}
	return "written"
}

func syncLyrics() error {
	dec := json.NewDecoder(os.Stdin)
	counts := map[string]int{"written": 0, "skipped": 0, "failed": 0}
	for {
		var s sidecar
		err := dec.Decode(&s)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("sync input: %w", err)
		}
		counts[writeSidecar(s)]++
	}
	enc := json.NewEncoder(os.Stdout)
	return enc.Encode(counts)
}

func main() {
	switch {
	case len(os.Args) == 2 && os.Args[1] == "sync":
		if err := syncLyrics(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case len(os.Args) >= 4 && os.Args[1] == "defaults":
		// defaults <pluginDataDir> <local/index.json> [--force]
		setLibraryDefault(os.Args[3])
		force := len(os.Args) > 4 && os.Args[4] == "--force"
		if err := writeDefaults(os.Args[2], force); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("defaults written")
	case len(os.Args) == 2:
		if err := readIndex(os.Args[1]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "usage: read-index <local/index.json> | sync | defaults <dataDir> <library> [--force]")
		os.Exit(2)
	}
}
