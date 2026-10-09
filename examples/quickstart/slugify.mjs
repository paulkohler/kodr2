/** Convert an ASCII title to a lowercase, hyphen-separated URL slug. */
export function slugify(title) {
  // Deliberately broken for the quickstart: only replaces the first space.
  return title.toLowerCase().replace(' ', '-');
}
