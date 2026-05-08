# pi-ext-webfetch

Fetch a URL and extract its main content as clean Markdown.

- Defuddle strips navigation, ads, and boilerplate.
- Result is written to a temp file — context stays small.
- Optional LLM distillation focuses the result on a question (off by default).

## Security

Before any HTTP request, the URL is validated:

- Only `http` and `https` schemes are allowed.
- The hostname is rejected if it is `localhost`, `*.local`, or `*.internal`.
- DNS is resolved up front and the request is refused if any returned address
  is loopback (`127.0.0.0/8`, `::1`), private (`10/8`, `172.16/12`,
  `192.168/16`, `fc00::/7`), link-local (`169.254/16`, `fe80::/10` —
  including AWS/GCP metadata at `169.254.169.254`), CGNAT, multicast, or
  reserved.
- Redirects are followed manually and each hop is re-validated; the chain is
  capped at 5 redirects.
- The response body is capped at 5 MB.

This blocks SSRF and stops the tool from being turned into a probe for
internal services on developer machines or CI runners.

## Configuration

```jsonc
{
  "extensionConfig": {
    "webfetch": {
      // Optional allowlist. When non-empty, only URLs whose host matches
      // (exact or subdomain, case-insensitive) are fetched.
      "allowedHosts": ["docs.python.org", "github.com"],

      // Whether `focus` may forward fetched content to a background model
      // for distillation. Default: false. Enable only when you trust both
      // the URL allowlist and the configured model provider — fetched
      // content originates from a model-controlled URL and could exfiltrate
      // sensitive data otherwise.
      "allowLLMDistill": false
    }
  }
}
```

## Tool

```
webfetch(url, focus?)
```

- `url` (required) — http/https URL to fetch.
- `focus` (optional) — only honoured when `allowLLMDistill` is `true`. The
  background model (`backgroundModels.primary.normal`) extracts the parts of
  the page that answer the focus question.

The tool returns a short summary (title, source, file path, preview). Use
the `read` tool on the returned `filePath` to inspect the full content.
