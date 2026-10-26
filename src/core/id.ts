let counter = 0;

/** Short unique id, sortable by creation time within a session. */
export function uid(): string {
  counter = (counter + 1) % 1679616;
  const rnd = Math.floor(Math.random() * 1679616);
  return Date.now().toString(36) + counter.toString(36).padStart(4, '0') + rnd.toString(36).padStart(4, '0');
}
