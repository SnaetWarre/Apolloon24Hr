import path from 'path';

export function relativeFileWithinRoot(rootDir: string, filePath: string): string | null {
  const root = path.resolve(rootDir);
  const relativePath = path.relative(root, path.resolve(filePath));

  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  return relativePath;
}
