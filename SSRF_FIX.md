# SSRF Protection Fix for SillyTavern

Since `listen: true` is enabled, you should add this block to your `config.yaml` to prevent SSRF (Server-Side Request Forgery) attacks.

### 1. The Snippet
Paste this block into your `config.yaml` file, preferably after the `hostWhitelist:` section:

```yaml
# Perform whitelist checks against server-side HTTP requests that resolve to private IP addresses.
# This is an additional layer of security to prevent Server-Side Request Forgery (SSRF) attacks.
privateAddressWhitelist:
  # Enable private address whitelist to block requests to private IP ranges.
  enabled: true
  # If true, requests to hosts that cannot be resolved will be allowed instead of blocked.
  allowUnresolvedHosts: false
  # Log blocked and allowed requests to the console.
  log:
    # Log blocked requests to the console with a warning message
    blockedRequests: true
    # Log allowed requests to the console with an info message
    allowedRequests: false
  # List of allowed private IP ranges (in CIDR notation or wildcard format).
  allowedRanges:
    - '127.0.0.0/8'      # Loopback (IPv4)
    - '::1/128'          # Loopback (IPv6)
```

### 2. Instructions
1. Open `config.yaml` in your root folder.
2. Find the section starting with `hostWhitelist:`.
3. Paste the snippet above right after it.
4. Save the file and **restart SillyTavern**.
5. Once done, remember to restore `/config.yaml` in your `.gitignore` (remove the `#` if you added one).
