export function inWorkWindow(config, instant = new Date()) {
  if (!config.enabled) return true;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const minutes =
    Number(parts.find((p) => p.type === "hour").value) * 60 +
    Number(parts.find((p) => p.type === "minute").value);
  const start = config.startHour * 60;
  return (minutes - start + 1440) % 1440 < config.hours * 60;
}
