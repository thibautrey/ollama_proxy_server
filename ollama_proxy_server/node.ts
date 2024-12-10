import { Command } from "commander";
import * as fs from "fs";
import * as http from "http";
import { parse as parseUrl } from "url";
import { parse as parseQuery } from "querystring";
import fetch, { Response } from "node-fetch";
import AbortController from "abort-controller";
import { getAuthorizedUsers, getConfig } from "./config";

// ------------------------------------------------------------
// Command-Line Arguments and Configuration
// ------------------------------------------------------------

const program = new Command();
program
  .option("--config <configFile>", "Path to the config file", "config.ini")
  .option(
    "--log_path <logPath>",
    "Path to the access log file",
    "access_log.txt"
  )
  .option(
    "--users_list <usersList>",
    "Path to the authorized users list",
    "authorized_users.txt"
  )
  .option("--port <port>", "Port number for the server", "8000")
  .option(
    "--retry_attempts <retries>",
    "Number of retry attempts for failed calls",
    "3"
  )
  .option("-d, --deactivate_security", "Deactivates security", false);

program.parse(process.argv);

const args = program.opts<{
  config: string;
  log_path: string;
  users_list: string;
  port: string;
  retry_attempts: string;
  deactivate_security: boolean;
}>();

const logFilePath: string = args.log_path;
const port: number = parseInt(args.port, 10) || 8000;
const retryAttempts: number = parseInt(args.retry_attempts, 10) || 3;
const deactivateSecurity: boolean = args.deactivate_security ? true : false;
let servers: ServersType = [];
let authorizedUsers: AuthorizedUsers = {};

// ------------------------------------------------------------
// Initialization of Servers and Authorized Users
// ------------------------------------------------------------

(async () => {
  servers = await getConfig();
  authorizedUsers = await getAuthorizedUsers();
})();

// ------------------------------------------------------------
// Logging
// ------------------------------------------------------------

function addAccessLogEntry(
  logPath: string,
  event: string,
  user: string,
  ipAddress: string | null,
  access: string,
  server: string,
  nbQueued: number,
  error = ""
): void {
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

// ------------------------------------------------------------
// Server Availability and Request Forwarding Helpers
// ------------------------------------------------------------

async function isServerAvailable(serverInfo: ServerInfo): Promise<boolean> {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(serverInfo.url, {
      method: "HEAD",
      signal: controller.signal,
    });
    clearTimeout(id);

    return response.ok;
  } catch {
    return false;
  }
}

async function sendRequestWithRetries(
  serverInfo: ServerInfo,
  method: string | undefined,
  fullPath: string,
  query: QueryParams,
  postData: PostData,
  headers: http.IncomingHttpHeaders,
  attempts: number,
  timeout: number
): Promise<Response | null> {
  const url = new URL(serverInfo.url + fullPath);

  for (const k in query) {
    const vals = query[k];
    for (const val of vals) {
      url.searchParams.append(k, val);
    }
  }

  for (let i = 0; i < attempts; i++) {
    console.log(`Attempt ${i + 1} forwarding request to ${url.href}`);

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout * 1000);

    const options: any = {
      method,
      headers: { ...headers },
      signal: controller.signal,
    };

    if (["POST", "PUT", "PATCH"].includes(method || "") && postData) {
      options.body = JSON.stringify(postData);
      if (!options.headers["Content-Type"]) {
        options.headers["Content-Type"] = "application/json";
      }
    }

    try {
      const response = await fetch(url.toString(), options);
      clearTimeout(id);
      console.log(`Received response with status code ${response.status}`);
      return response;
    } catch (err: any) {
      clearTimeout(id);
      if (err.name === "AbortError") {
        console.log(
          `Timeout on attempt ${i + 1} forwarding request to ${serverInfo.url}`
        );
      } else {
        console.log(`Error on attempt ${i + 1} forwarding request: ${err}`);
      }
    }
  }

  return null;
}

// ------------------------------------------------------------
// Request Handler
// ------------------------------------------------------------

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const clientIp = req.socket.remoteAddress;
  const clientPort = req.socket.remotePort;
  let user = "unknown";

  // Handle authorization if security is not deactivated
  if (!deactivateSecurity) {
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.log("User is not authorized");
      addAccessLogEntry(
        logFilePath,
        "rejected",
        "unknown",
        clientIp || null,
        "Denied",
        "None",
        -1,
        "Authentication failed"
      );
      res.writeHead(403);
      res.end();
      return;
    }

    const token = authHeader.substring("Bearer ".length);
    const parts = token.split(":");
    if (parts.length !== 2) {
      console.log("User is not authorized");
      addAccessLogEntry(
        logFilePath,
        "rejected",
        token,
        clientIp || null,
        "Denied",
        "None",
        -1,
        "Authentication failed"
      );
      res.writeHead(403);
      res.end();
      return;
    }

    const [u, k] = parts;
    if (authorizedUsers[u] !== k) {
      console.log("User is not authorized");
      addAccessLogEntry(
        logFilePath,
        "rejected",
        token,
        clientIp || null,
        "Denied",
        "None",
        -1,
        "Authentication failed"
      );
      res.writeHead(403);
      res.end();
      return;
    }
    user = u;
  }

  // Parse URL and Query
  const parsedUrl = parseUrl(req.url || "");
  const pathName = parsedUrl.pathname || "";
  const getParamsObj = parseQuery(parsedUrl.query || "");
  const getParams: QueryParams = {};

  for (const k of Object.keys(getParamsObj)) {
    const val = getParamsObj[k];
    getParams[k] = Array.isArray(val)
      ? val.map((v) => v.toString())
      : [String(val)];
  }

  console.log(`Incoming request from ${clientIp}:${clientPort}`);
  console.log(`Request method: ${req.method}`);
  console.log(`Request path: ${pathName}`);
  console.log(`Query parameters: ${JSON.stringify(getParams)}`);

  // Parse POST data if applicable
  let postData: PostData = {};
  if (req.method === "POST") {
    const body: string = await new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => resolve(data));
    });

    try {
      postData = JSON.parse(body);
      console.log(`POST data: ${JSON.stringify(postData)}`);
    } catch (e: any) {
      console.log(`Failed to decode POST data: ${e}`);
      postData = {};
    }
  }

  // Extract model if present
  let model: string | undefined =
    postData.model || (getParams["model"] ? getParams["model"][0] : undefined);
  console.log(`Extracted model: ${model}`);

  const modelBasedEndpoints = [
    "/api/generate",
    "/api/chat",
    "/generate",
    "/chat",
  ];

  // Prepare headers to forward to backend
  const backendHeaders: http.IncomingHttpHeaders = { ...req.headers };
  delete backendHeaders["authorization"];
  delete backendHeaders["host"];

  // Handle model-based endpoints
  if (modelBasedEndpoints.includes(pathName)) {
    if (!model) {
      // Model is required for these endpoints
      res.writeHead(400);
      res.end("Missing 'model' in request");
      console.log("Missing 'model' in request");
      return;
    }

    let availableServers = servers.filter(([_, info]) =>
      info.models.includes(model!)
    );

    if (availableServers.length === 0) {
      console.log(`No servers support model '${model}'.`);
      res.writeHead(503);
      res.end("No servers support the requested model.");
      return;
    }

    console.log(
      `Available servers for model '${model}': ${availableServers.map(
        (s) => s[0]
      )}`
    );

    let response: Response | null = null;

    // Attempt to find a responding server
    while (availableServers.length > 0) {
      // Sort by queue length
      availableServers.sort((a, b) => a[1].queue.length - b[1].queue.length);
      const [serverName, serverInfo] = availableServers[0];

      if (!(await isServerAvailable(serverInfo))) {
        console.log(`Server ${serverName} is not available.`);
        availableServers.shift();
        continue;
      }

      const queue = serverInfo.queue;

      // Simulate add to queue
      queue.push(1);
      addAccessLogEntry(
        logFilePath,
        "gen_request",
        user,
        clientIp || null,
        "Authorized",
        serverName,
        queue.length
      );

      try {
        response = await sendRequestWithRetries(
          serverInfo,
          req.method,
          pathName,
          getParams,
          postData,
          backendHeaders,
          retryAttempts,
          serverInfo.timeout
        );

        if (response) {
          // Stream response back to client
          const headersToSend: { [key: string]: string } = {};
          response.headers.forEach((value, key) => {
            if (
              ![
                "content-length",
                "transfer-encoding",
                "content-encoding",
              ].includes(key.toLowerCase())
            ) {
              headersToSend[key] = value;
            }
          });
          headersToSend["Transfer-Encoding"] = "chunked";
          res.writeHead(response.status, headersToSend);

          if (response.body instanceof ReadableStream) {
            const reader = response.body.getReader();

            async function pump() {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                  const chunkSize = value.length.toString(16).toUpperCase();
                  res.write(chunkSize + "\r\n");
                  res.write(value);
                  res.write("\r\n");
                }
              }
              res.write("0\r\n\r\n");
              res.end();
            }
            await pump();
          }
          break;
        } else {
          // All retries failed for this server
          console.log(`All retries failed for server ${serverName}`);
          availableServers.shift();
        }
      } finally {
        // Remove one from queue
        queue.pop();
        addAccessLogEntry(
          logFilePath,
          "gen_done",
          user,
          clientIp || null,
          "Authorized",
          serverName,
          queue.length
        );
      }
    }

    if (!response) {
      // No server could handle the request
      res.writeHead(503);
      res.end("No available servers could handle the request.");
    }
  } else {
    // Non-model endpoints: Use default server
    const [defaultServerName, defaultServerInfo] = servers[0];

    if (!(await isServerAvailable(defaultServerInfo))) {
      res.writeHead(503);
      res.end("Default server is not available.");
      return;
    }

    const response = await sendRequestWithRetries(
      defaultServerInfo,
      req.method,
      pathName,
      getParams,
      postData,
      backendHeaders,
      retryAttempts,
      defaultServerInfo.timeout
    );

    if (response) {
      const headersToSend: { [key: string]: string } = {};
      response.headers.forEach((value, key) => {
        if (
          !["content-length", "transfer-encoding", "content-encoding"].includes(
            key.toLowerCase()
          )
        ) {
          headersToSend[key] = value;
        }
      });
      headersToSend["Transfer-Encoding"] = "chunked";
      res.writeHead(response.status, headersToSend);

      if (response.body instanceof ReadableStream) {
        const reader = response.body.getReader();
        async function pump() {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              const chunkSize = value.length.toString(16).toUpperCase();
              res.write(chunkSize + "\r\n");
              res.write(value);
              res.write("\r\n");
            }
          }
          res.write("0\r\n\r\n");
          res.end();
        }
        await pump();
      }
    } else {
      res.writeHead(503);
      res.end("Failed to forward request to default server.");
    }
  }
}

// ------------------------------------------------------------
// Server Startup and Shutdown
// ------------------------------------------------------------

console.log("Ollama Proxy server");
console.log("Author: thibautrey");
console.log("Starting server");

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Unhandled error in request handling:", err);
    res.writeHead(500);
    res.end("Internal server error");
  });
});

server.listen(port, () => {
  console.log(`Running server on port ${port}`);
});

process.on("SIGINT", () => {
  console.log("Shutting down the server.");
  server.close(() => {
    process.exit(0);
  });
});
