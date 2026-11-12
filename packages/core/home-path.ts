/** A path as a person types it: a leading `~` stands for the home directory. */
export const expandHomePath = (path: string, home: string) => path === '~' || path.startsWith('~/') ? home + path.slice(1) : path;
