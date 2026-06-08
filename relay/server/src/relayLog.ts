/**
 * 升级控制面统一结构化日志：所有字段以 JSON 输出，便于 stdout 采集。
 * 关键字段固定为 event/upgrade_id/device_id/reason，方便日志检索。
 */
interface UpgradeLogFields {
  event: string;
  upgrade_id?: string;
  device_id?: string;
  reason?: string;
  source_role?: string;
}

export function logUpgradeEvent(fields: UpgradeLogFields): void {
  const record: Record<string, unknown> = {};
  if (fields.upgrade_id) record.upgrade_id = fields.upgrade_id;
  if (fields.device_id) record.device_id = fields.device_id;
  if (fields.reason) record.reason = fields.reason;
  if (fields.source_role) record.source_role = fields.source_role;
  logRelayEvent({ event: fields.event, ...record });
}

export function logRelayEvent(fields: Record<string, unknown>): void {
  const record: Record<string, unknown> = {
    ts: formatLocalTimestamp(),
    component: "omniwork-relay",
    ...fields,
  };
  console.info(JSON.stringify(record));
}

function formatLocalTimestamp(date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffsetMinutes / 60);
  const offsetRemainderMinutes = absoluteOffsetMinutes % 60;

  return [
    `${date.getFullYear()}-${padNumber(date.getMonth() + 1, 2)}-${padNumber(
      date.getDate(),
      2,
    )}`,
    "T",
    `${padNumber(date.getHours(), 2)}:${padNumber(
      date.getMinutes(),
      2,
    )}:${padNumber(
      date.getSeconds(),
      2,
    )}.${padNumber(date.getMilliseconds(), 3)}`,
    `${sign}${padNumber(offsetHours, 2)}:${padNumber(
      offsetRemainderMinutes,
      2,
    )}`,
  ].join("");
}

function padNumber(value: number, length: number): string {
  return String(value).padStart(length, "0");
}
