function createSerializedWriter(writeOperation, onPreviousError = () => {}) {
  if (typeof writeOperation !== "function") throw new TypeError("writeOperation must be a function");
  let chain = Promise.resolve();

  return {
    write(value) {
      chain = chain
        .catch((error) => onPreviousError(error))
        .then(() => writeOperation(value));
      return chain;
    },
  };
}

function selectLatestValidCandidate(candidates, isValid) {
  const priority = { primary: 3, temporary: 2, backup: 1 };
  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate && isValid(candidate.raw))
    .sort((a, b) => {
      const revisionDifference = b.raw.revision - a.raw.revision;
      if (revisionDifference) return revisionDifference;
      return (priority[b.kind] || 0) - (priority[a.kind] || 0);
    })[0] || null;
}

module.exports = { createSerializedWriter, selectLatestValidCandidate };
