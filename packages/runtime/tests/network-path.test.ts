import { describe, expect, it } from 'vitest';
import { isNetworkOrDevicePath } from '../src/network-path';

describe('network and device paths (decision 8)', () => {
  it.each([
    '\\\\server\\share\\project', '//server/share/project', '\\/server/share', '/\\server\\share',
    '\\\\?\\UNC\\server\\share', '\\\\?\\C:\\local', '\\\\.\\pipe\\name', '\\\\.\\C:\\local', '\\\\.\\UNC\\server\\share',
    '\\\\;LanmanRedirector\\;Z:0\\server\\share', '\\\\host@SSL\\DavWWWRoot\\project',
    '\\??\\UNC\\server\\share', '\\??\\C:\\local', '/??/UNC/server/share', '\\??/C:/local',
  ])('refuses %s', value => expect(isNetworkOrDevicePath(value)).toBe(true));

  // A leading space makes a path relative, which every caller rejects or resolves to a local path.
  it.each([
    'C:\\projects\\app', 'c:/projects/app', '\\projects\\app', '/projects/app', 'relative\\path', 'C:relative', '',
    ' \\\\server\\share', '?\\??\\x',
  ])('allows %s', value => expect(isNetworkOrDevicePath(value)).toBe(false));
});
