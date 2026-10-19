const SECRET_MARKERS = ['-----BEGIN', 'sk-ant-', 'sk-proj-', 'ghp_', 'github_pat_', 'AKIA', 'xoxb-']

/** Text that carries a credential marker is never written to the Wiki. */
export function looksSecret(text: string): boolean {
  return SECRET_MARKERS.some((marker) => text.includes(marker))
}
