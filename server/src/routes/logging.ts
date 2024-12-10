import * as fs from "fs";

export function addAccessLogEntry(
  event: string,
  user: string,
  ipAddress: string | null,
  access: string,
  server: string,
  nbQueued: number,
  error = ""
): void {
  const logPath = "/logs/log.log";
  const fields = [
    "time_stamp",
    "event",
    "user_name",
    "ip_address",
    "access",
    "server",
    "nb_queued_requests_on_server",
    "error",
  ];

  const now = new Date().toISOString();
  const row: LogEntry = {
    time_stamp: now,
    event,
    user_name: user,
    ip_address: ipAddress,
    access,
    server,
    nb_queued_requests_on_server: nbQueued,
    error,
  };

  let writeHeader = false;
  if (!fs.existsSync(logPath)) {
    writeHeader = true;
  }

  const csvLine = (obj: LogEntry) =>
    fields.map((f) => JSON.stringify((obj as any)[f] || "")).join(",");

  const fd = fs.openSync(logPath, "a");
  if (writeHeader) {
    fs.writeSync(fd, fields.join(",") + "\n");
  }
  fs.writeSync(fd, csvLine(row) + "\n");
  fs.closeSync(fd);
}
