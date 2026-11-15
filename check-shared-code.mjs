import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export function sharedCodeMismatches() {
  const { files } = JSON.parse(readFileSync(join(root, 'shared-code.json'), 'utf8'));
  return Object.entries(files).flatMap(([file, expected]) => {
    const actual = createHash('sha256').update(readFileSync(join(root, file)).toString()).digest('hex');
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
