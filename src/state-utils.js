export function preferNewestState(current, incoming) {
  if (!incoming || typeof incoming !== "object") return current;
  if (!current || typeof current !== "object") return incoming;

  const currentRevision = Number.isInteger(current.revision) ? current.revision : -1;
  const incomingRevision = Number.isInteger(incoming.revision) ? incoming.revision : -1;
  return incomingRevision < currentRevision ? current : incoming;
}
