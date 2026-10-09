/** Lowercase without accents, so "zoe" finds Zoë and "celine" finds Céline. */
export function foldSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}
