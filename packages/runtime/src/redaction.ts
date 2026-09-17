// Defense in depth. This is deliberately not described as a complete secret detector.
export class Redactor {
  private readonly secrets = new Set<string>();
  add(secret: string): void { if (secret.length >= 4) this.secrets.add(secret); }
  text(value: string): string {
    let output = value;
    for (const secret of this.secrets) output = output.split(secret).join('[REDACTED]');
    return output
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
      .replace(/\b(authorization\s*[:=]\s*(?:bearer\s+)?|(?:api[_-]?key|password|client_secret|access_token)\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
  }
}
