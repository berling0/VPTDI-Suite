// MSA15 Manager launcher: serves the embedded user interface on a private local port
// and shows it in its own window. No data leaves the machine; the page does all the work.
package main

import (
	"embed"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"time"
)

//go:embed docs
var webFS embed.FS

var (
	lastSeen atomic.Int64 // unix nanos of the last request from the window
	seen     atomic.Bool
	byeAt    atomic.Int64
)

const idleLimit = 3 * time.Minute // browsers slow down timers of minimised windows, so be generous

func main() {
	sub, err := fs.Sub(webFS, "docs")
	if err != nil {
		fatal(err.Error())
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fatal("Cannot open a local port: " + err.Error())
	}
	url := fmt.Sprintf("http://127.0.0.1:%d/", ln.Addr().(*net.TCPAddr).Port)

	files := http.FileServer(http.FS(sub))
	mux := http.NewServeMux()
	mux.HandleFunc("/ping", func(w http.ResponseWriter, r *http.Request) { touch(); w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("/bye", func(w http.ResponseWriter, r *http.Request) {
		byeAt.Store(time.Now().UnixNano())
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		touch()
		w.Header().Set("Cache-Control", "no-store")
		files.ServeHTTP(w, r)
	})
	go func() {
		if err := http.Serve(ln, mux); err != nil {
			fatal(err.Error())
		}
	}()

	if os.Getenv("MSA15_NO_BROWSER") != "" {
		fmt.Println(url)
	} else if cmd := openWindow(url); cmd != nil {
		// A dedicated app window: when it is closed, we are done.
		go func() {
			start := time.Now()
			_ = cmd.Wait()
			if time.Since(start) > 5*time.Second {
				os.Exit(0)
			}
			// It returned at once (handed over to an already running browser): rely on the heartbeat instead.
		}()
	}

	started := time.Now()
	for {
		time.Sleep(500 * time.Millisecond)
		now := time.Now()
		if !seen.Load() {
			if now.Sub(started) > idleLimit {
				os.Exit(0) // the window never appeared
			}
			continue
		}
		last := time.Unix(0, lastSeen.Load())
		if bye := byeAt.Load(); bye != 0 && last.Before(time.Unix(0, bye)) && now.Sub(time.Unix(0, bye)) > 3*time.Second {
			os.Exit(0) // window closed (a reload would have asked for the page again by now)
		}
		if now.Sub(last) > idleLimit {
			os.Exit(0)
		}
	}
}

func touch() { lastSeen.Store(time.Now().UnixNano()); seen.Store(true) }

// openWindow shows url in a chromeless Edge/Chrome "app" window when one is installed,
// otherwise in the default browser. It returns the process only for a dedicated app window.
func openWindow(url string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		var candidates []string
		for _, root := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LocalAppData")} {
			if root == "" {
				continue
			}
			candidates = append(candidates,
				filepath.Join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
				filepath.Join(root, "Google", "Chrome", "Application", "chrome.exe"))
		}
		profile := filepath.Join(os.Getenv("LocalAppData"), "MSA15Editor", "window")
		for _, exe := range candidates {
			if _, err := os.Stat(exe); err != nil {
				continue
			}
			cmd := exec.Command(exe, "--app="+url, "--user-data-dir="+profile, "--no-first-run", "--no-default-browser-check", "--window-size=1500,950")
			if cmd.Start() == nil {
				return cmd
			}
		}
		if exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start() != nil {
			fatal("Could not open a browser window. Open this address by hand: " + url)
		}
		return nil
	}
	opener := "xdg-open"
	if runtime.GOOS == "darwin" {
		opener = "open"
	}
	_ = exec.Command(opener, url).Start()
	return nil
}

func fatal(msg string) {
	showError(msg)
	os.Exit(1)
}
