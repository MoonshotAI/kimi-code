# Go CLI Layout

A standalone Go CLI project that can live in any directory.

## Contents

- Init
- Directory structure
- browser/client.go — daemon client, tab reuse
- output/output.go — JSON envelope
- cmd/root.go — `--daemon-url`, command registration
- Build and run

## Init

```bash
mkdir {platform}-cli && cd {platform}-cli
go mod init {platform}-cli
go get github.com/spf13/cobra
```

## Directory structure

```
{platform}-cli/
├── go.mod
├── main.go                  # calls cmd.Execute(), exits 1 on error
├── browser/
│   └── client.go            # daemon HTTP client
├── output/
│   └── output.go            # JSON output envelope
├── {platform}/
│   ├── login.go             # login status (if the site requires login)
│   └── {feature}.go         # one file per feature
├── cmd/
│   └── root.go              # cobra command registration
└── skill/
    └── {platform}-cli/
        └── SKILL.md         # companion skill (Phase 4)
```

## browser/client.go

```go
package browser

import (
    "bytes"
    "encoding/json"
    "fmt"
    "net/http"
    "time"
)

const DefaultDaemonURL = "http://127.0.0.1:10086"

type Client struct {
    baseURL string
    session string
    http    *http.Client
}

func NewClient(baseURL, session string) *Client {
    return &Client{
        baseURL: baseURL,
        session: session,
        http:    &http.Client{Timeout: 90 * time.Second},
    }
}

func (c *Client) Call(action string, args map[string]any) (json.RawMessage, error) {
    body, _ := json.Marshal(map[string]any{
        "action":  action,
        "session": c.session,
        "args":    args,
    })
    resp, err := c.http.Post(c.baseURL+"/command", "application/json", bytes.NewReader(body))
    if err != nil {
        return nil, fmt.Errorf("daemon unreachable: %w", err)
    }
    defer resp.Body.Close()
    var result struct {
        OK    bool            `json:"ok"`
        Data  json.RawMessage `json:"data"`
        Error *struct {
            Code    string `json:"code"`
            Message string `json:"message"`
        } `json:"error"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, err
    }
    if !result.OK {
        if result.Error == nil {
            return nil, fmt.Errorf("unexpected reply from %s: not the kimi-webbridge daemon?", c.baseURL)
        }
        return nil, fmt.Errorf("%s: %s", result.Error.Code, result.Error.Message)
    }
    return result.Data, nil
}

// OpenTab reuses the CLI's tab when it is still open, so repeated runs
// don't pile up tabs.
func (c *Client) OpenTab(url string) error {
    if _, err := c.Call("find_tab", map[string]any{"url": url}); err == nil {
        return nil
    }
    _, err := c.Call("navigate", map[string]any{"url": url, "newTab": true})
    return err
}

func (c *Client) Evaluate(code string) (json.RawMessage, error) {
    return c.Call("evaluate", map[string]any{"code": code})
}
```

## output/output.go

```go
package output

import (
    "encoding/json"
    "fmt"
    "os"
)

func Success(data any) {
    printJSON(map[string]any{"ok": true, "data": data})
}

func Error(code, message string) {
    printJSON(map[string]any{"ok": false, "error": map[string]any{"code": code, "message": message}})
}

func printJSON(v any) {
    enc := json.NewEncoder(os.Stdout)
    enc.SetEscapeHTML(false)
    enc.SetIndent("", "  ")
    if err := enc.Encode(v); err != nil {
        fmt.Fprintf(os.Stderr, "output error: %v\n", err)
    }
}
```

## cmd/root.go

```go
package cmd

import (
    "os"

    "github.com/spf13/cobra"
    "{platform}-cli/browser"
    "{platform}-cli/output"
    "{platform}-cli/{platform}"
)

var daemonURL string

var rootCmd = &cobra.Command{
    Use:   "{platform}-cli",
    Short: "{Platform} automation CLI",
}

func Execute() error {
    return rootCmd.Execute()
}

func newClient() *browser.Client {
    return browser.NewClient(daemonURL, "{platform}")
}

func init() {
    rootCmd.PersistentFlags().StringVar(&daemonURL, "daemon-url", browser.DefaultDaemonURL, "address of the kimi-webbridge daemon")

    searchCmd := &cobra.Command{
        Use:   "search <query>",
        Short: "Search {Platform}",
        Args:  cobra.ExactArgs(1),
        Run: func(cmd *cobra.Command, args []string) {
            limit, _ := cmd.Flags().GetInt("limit")
            items, err := {platform}.Search(newClient(), args[0], limit)
            if err != nil {
                output.Error("search_error", err.Error())
                os.Exit(1)
            }
            output.Success(items)
        },
    }
    searchCmd.Flags().Int("limit", 20, "max items to return")
    rootCmd.AddCommand(searchCmd)
}
```

## Build and run

```bash
go build -o {platform}-cli .
./{platform}-cli --help
./{platform}-cli search "keyword" --limit 5
```
