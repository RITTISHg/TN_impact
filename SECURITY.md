# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in this project, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, contact the maintainer directly.

## Security Measures

### Web Dashboard (Vercel Deployment)

| Protection | Implementation |
|-----------|---------------|
| **Content Security Policy (CSP)** | Only allows scripts from `self` and `cdn.jsdelivr.net` (Chart.js). Blocks inline scripts and unauthorized sources. |
| **XSS Prevention** | All dynamic content uses `textContent` or `escapeHTML()` — zero raw `innerHTML` with user data. |
| **Clickjacking Protection** | `X-Frame-Options: DENY` prevents embedding in iframes. |
| **HTTPS Enforcement** | `Strict-Transport-Security` with 2-year max-age and preload. |
| **MIME Sniffing Protection** | `X-Content-Type-Options: nosniff` prevents MIME type attacks. |
| **Referrer Policy** | `strict-origin-when-cross-origin` limits referrer leakage. |
| **Permissions Policy** | Disables camera, microphone, geolocation, and FLoC. |
| **Input Validation** | All sensor inputs clamped to safe ranges. Settings inputs validated and sanitized. |
| **Download Sanitization** | Report downloads validate type against allowlist and sanitize filenames. |

### Python Dashboard

| Protection | Implementation |
|-----------|---------------|
| **No Exposed Credentials** | No API keys, passwords, or tokens in source code. |
| **Serial Input Validation** | Sensor data parsed with error handling; malformed data is rejected. |
| **Safe File I/O** | Model files loaded only from whitelisted `saved_models/` directory. |
| **No Network Exposure** | Python dashboard runs locally — no open ports or HTTP servers. |

### Repository

| Protection | Implementation |
|-----------|---------------|
| **`.gitignore` Hardened** | Blocks `.env`, `*.pem`, `*.key`, `credentials.json`, and secrets files. |
| **No Secrets in Code** | Verified: zero instances of `password`, `secret`, `api_key`, or `token` in codebase. |
| **Public Repo Safe** | All code is safe for public viewing. No sensitive data exposed. |

## Dependencies

| Package | Version | Security Status |
|---------|---------|----------------|
| ONNX Runtime | 1.23.2 | ✅ Latest stable |
| Chart.js | 4.4.1 | ✅ CDN with SRI-compatible |
| scikit-learn | Latest | ✅ No known vulnerabilities |
| NumPy | Latest | ✅ No known vulnerabilities |
