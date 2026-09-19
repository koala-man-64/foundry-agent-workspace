// Defense in depth. This is deliberately not described as a complete secret detector.
export class Redactor {
  private readonly secrets = new Set<string>();
  add(secret: string): void {
    if (secret.length < 4) return;
    // Everything durable and everything shown is JSON: SQLite rows, diagnostics bundles, provider
    // state and renderer events all carry the escaped form, and an approval's serialized tool
    // arguments are escaped twice. A secret containing a quote, a backslash or a newline no longer
    // appears literally in those texts, so every encoding level is screened as its own needle.
    let value = secret;
    for (let level = 0; level < 3 && !this.secrets.has(value); level++) {
      this.secrets.add(value);
      value = JSON.stringify(value).slice(1, -1);
    }
  }
  text(value: string): string {
    let output = value;
    for (const secret of this.secrets) output = output.split(secret).join('[REDACTED]');
    return output
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
      .replace(/\b(authorization\s*[:=]\s*(?:bearer\s+)?|(?:api[_-]?key|password|client_secret|access_token)\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
      // A token carried in tool output, MCP stderr or an exception rarely arrives under a labelled header.
      .replace(/\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'bearer [REDACTED]');
  }
}
