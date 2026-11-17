import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// A file's fingerprint ignores line endings: a Windows checkout (CRLF) and the Linux CI runner (LF) see the same
// file. Hashing the raw bytes made the check pass on one and fail on the other.
export function fingerprint(file) {
  return createHash('sha256').update(readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
}

export function sharedCodeMismatches() {
  const { files } = JSON.parse(readFileSync(join(root, 'shared-code.json'), 'utf8'));
  return Object.entries(files).flatMap(([file, expected]) => {
    const actual = fingerprint(file);
    return actual === expected ? [] : [{ file, expected, actual }];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mismatches = sharedCodeMismatches();
  if (mismatches.length) {
    console.error('Shared files differ from the approved copies. Update both apps and shared-code.json together:');
    for (const mismatch of mismatches) console.error(`${mismatch.file}: expected ${mismatch.expected}, got ${mismatch.actual}`);
    process.exitCode = 1;
  } else {
    console.log('Shared files match the approved copies.');
  }
}
