const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(version) {
  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error(`Invalid release version: ${version}.`);
  }
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

export function resolveReleaseVersion(currentVersion, requestedVersion) {
  const current = parseVersion(currentVersion);
  let next;

  switch (requestedVersion) {
    case "patch":
      next = [current[0], current[1], current[2] + 1];
      break;
    case "minor":
      next = [current[0], current[1] + 1, 0];
      break;
    case "major":
      next = [current[0] + 1, 0, 0];
      break;
    default:
      if (!VERSION_PATTERN.test(requestedVersion)) {
        throw new Error(
          "Release argument must be patch, minor, major, or an exact version such as 0.5.2.",
        );
      }
      next = parseVersion(requestedVersion);
  }

  if (compareVersions(next, current) <= 0) {
    throw new Error(
      `Release version ${next.join(".")} must be newer than ${currentVersion}.`,
    );
  }

  return next.join(".");
}

export function updateConsumerVersion(document, currentVersion, nextVersion) {
  if (!document.includes(currentVersion)) {
    throw new Error(
      `CONSUMER.md does not reference current version ${currentVersion}.`,
    );
  }
  return document.replaceAll(currentVersion, nextVersion);
}
