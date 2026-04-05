import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_SCAN_DEPTH = 6;

export async function findRepoFolder(
  groupPath: string,
  folderName: string,
  depth = 0,
): Promise<string | null> {
  if (depth > MAX_SCAN_DEPTH) return null;

  const entries = await readdir(groupPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const fullPath = join(groupPath, entry.name);

    if (entry.name === folderName) {
      const hasPackageJson = await fileExists(join(fullPath, 'package.json'));
      if (hasPackageJson) return fullPath;
    }

    const found = await findRepoFolder(fullPath, folderName, depth + 1);
    if (found !== null) return found;
  }

  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
