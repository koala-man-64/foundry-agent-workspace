/** Newline framing with a byte limit per message, not per transport chunk. */
export class LineDecoder {
  private buffer = '';
  private readonly encoder = new TextEncoder();
  constructor(private readonly maximumBytes: number) {}
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (this.encoder.encode(line).byteLength > this.maximumBytes) throw new Error('RPC message exceeds the byte limit.');
      lines.push(line);
    }
    if (this.encoder.encode(this.buffer).byteLength > this.maximumBytes) throw new Error('RPC message exceeds the byte limit.');
    return lines;
  }
}
