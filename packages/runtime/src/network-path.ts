// Windows authenticates to whatever server a path names, so opening a network path that the renderer supplied could send
// the user's NTLM credentials to a hostile host. Every renderer-supplied path, and every saved project path the renderer
// can make the runtime open, is checked with this before anything touches the filesystem (migration plan, decision 8).
// A mapped drive letter is not caught here; projects additionally refuse a canonical path on a network share.

const NETWORK_OR_DEVICE = /^(?:[\\/]{2}|[\\/]\?\?[\\/])/;

/** UNC (`\\server\share`, `//server/share`), Win32 device (`\\?\`, `\\.\`) and NT-namespace (`\??\`) paths. */
export function isNetworkOrDevicePath(value: string): boolean {
  return NETWORK_OR_DEVICE.test(value);
}
