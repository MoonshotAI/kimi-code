const MAX_WORKDIR_SLUG_LENGTH = 40;

export function slugifyWorkDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, MAX_WORKDIR_SLUG_LENGTH)
    .replaceAll(/^-+|-+$/g, '');
  return slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
}
