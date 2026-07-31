function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;

  return minutes === 0
    ? `UTC${sign}${hours}`
    : `UTC${sign}${hours}:${pad2(minutes)}`;
}

export function formatAgentStartMessage(
  runName: string,
  branch: string,
  startedAt: Date
): string {
  const localDate = [
    startedAt.getFullYear(),
    pad2(startedAt.getMonth() + 1),
    pad2(startedAt.getDate()),
  ].join("-");
  const localTime = `${pad2(startedAt.getHours())}:${pad2(startedAt.getMinutes())}`;
  const utcOffset = formatUtcOffset(-startedAt.getTimezoneOffset());

  return `[${runName}] Started on branch ${branch} - ${localDate} ${localTime} ${utcOffset}`;
}
