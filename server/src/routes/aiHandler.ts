import * as http from "http";
import { parse as parseUrl } from "url";
import { parse as parseQuery } from "querystring";
import fetch, { Response } from "node-fetch";

// Types for clarity
interface ServerInfo {
  url: string;
  models: string[];
  queue: any[];
  timeout: number;
}

type ServersType = Array<[string, ServerInfo]>;
type AuthorizedUsers = { [key: string]: string };
type PostData = { [key: string]: any };
type QueryParams = { [key: string]: string[] };

// We'll receive these values from the main file
let servers: ServersType = [];
let authorizedUsers: AuthorizedUsers = {};
let retryAttempts = 3;
let deactivateSecurity = false;

async function pump(
  res: http.ServerResponse,
  reader: ReadableStreamDefaultReader<Uint8Array>
) {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
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

/**
 * Initialize or update the AI handler configuration.
 */
export function configureAiHandler(
  newServers: ServersType,
  newAuthorizedUsers: AuthorizedUsers,
  newRetryAttempts: number,
  newDeactivateSecurity: boolean
) {
  servers = newServers;
  authorizedUsers = newAuthorizedUsers;
  retryAttempts = newRetryAttempts;
  deactivateSecurity = newDeactivateSecurity;
}

async function isServerAvailable(serverInfo: ServerInfo): Promise<boolean> {
  const timeout = 2000;

  console.log(`[DEBUG] Checking availability of server: ${serverInfo.url}`);
  const timeoutPromise = new Promise<boolean>((resolve) => {
    setTimeout(() => {
      resolve(false);
    }, timeout);
  });

  try {
    const fetchPromise = fetch(serverInfo.url, { method: "GET" }).then(
      (res) => {
        console.log(`[DEBUG] Availability check response: ${res.status}`);
        return res.ok;
      }
    );
    const result = await Promise.race([fetchPromise, timeoutPromise]);
    console.log(`[DEBUG] Server ${serverInfo.url} available: ${result}`);
    return result;
  } catch (err) {
    console.log(
      `[ERROR] Server availability check failed for ${serverInfo.url}: ${err}`
    );
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

  // Append query parameters to the URL
  for (const [key, values] of Object.entries(query)) {
    for (const value of values) {
      url.searchParams.append(key, value);
    }
  }

  // Create request options
  const options = {
    method,
    headers: { ...headers },
  };

  // Set request body for applicable methods
  if (["POST", "PUT", "PATCH"].includes(method || "") && postData) {
    // @ts-ignore
    options.body = JSON.stringify(postData);
    options.headers = {
      ...options.headers,
      "Content-Type": options.headers["Content-Type"] || "application/json",
    };
  }

  for (let i = 0; i < attempts; i++) {
    try {
      // @ts-ignore
      const fetchPromise = fetch(url.toString(), options);
      const timeoutPromise = new Promise<Response>((_, reject) =>
        setTimeout(() => {
          reject(new Error("Timeout"));
        }, timeout * 1000)
      );

      const response = (await Promise.race([
        fetchPromise,
        timeoutPromise,
      ])) as Response;

      return response;
    } catch (err: any) {
      if (err && err.message === "Timeout") {
        console.log(
          `[WARN] Timeout on attempt ${i + 1} forwarding request to ${
            serverInfo.url
          }`
        );
      } else {
        console.log(
          `[ERROR] Error on attempt ${i + 1} forwarding request: ${err}`
        );
      }
    }
  }

  console.log(
    "[WARN] All attempts exhausted, returning null from sendRequestWithRetries"
  );
  return null;
}

/**
 * Handle AI-related requests that are not covered by the /users endpoint.
 */
export async function handleAiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const clientIp = req.socket.remoteAddress;
  const clientPort = req.socket.remotePort;
  let user = "unknown";

  // Handle authorization if security is not deactivated
  if (!deactivateSecurity) {
    const authHeader = req.headers["authorization"]
      ? req.headers["authorization"]
      : (req.headers["Authorization"] as string);
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.log("[WARN] User is not authorized: Missing Bearer token");
      res.writeHead(403);
      res.end();
      return;
    }

    const token = authHeader.substring("Bearer ".length);
    console.log(`[DEBUG] Received token: ${token}`);
    const parts = token.split(":");
    if (parts.length !== 2) {
      console.log("[WARN] User is not authorized: Token format invalid");
      res.writeHead(403);
      res.end();
      return;
    }

    const [u, k] = parts;
    if (authorizedUsers[u] !== k) {
      console.log("[WARN] User is not authorized: Incorrect token");
      res.writeHead(403);
      res.end();
      return;
    }
    user = `${u}`;
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

  // Parse POST data if applicable
  let postData: PostData = {};
  if (req.method === "POST") {
    const body: string = await new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => {
        resolve(data);
      });
      req.on("error", (err) => {
        console.log(`[ERROR] Error receiving POST body: ${err}`);
      });
    });

    try {
      postData = JSON.parse(body);
    } catch (e: any) {
      console.log(`[ERROR] Failed to decode POST data: ${e}`);
      postData = {};
    }
  }

  // Extract model if present
  let model: string | undefined =
    postData.model || (getParams["model"] ? getParams["model"][0] : undefined);
  console.log(`[DEBUG] Extracted model: ${model}`);

  const modelBasedEndpoints = [
    "/api/generate",
    "/api/chat",
    "/generate",
    "/chat",
    "/chat/completions",
    "/api/completions",
  ];

  // Prepare headers to forward to backend
  const backendHeaders: http.IncomingHttpHeaders = { ...req.headers };
  delete backendHeaders["authorization"];
  delete backendHeaders["host"];

  if (modelBasedEndpoints.includes(pathName)) {
    if (!model) {
      console.log("[WARN] Missing 'model' in request");
      res.writeHead(400);
      res.end("Missing 'model' in request");
      return;
    }

    let availableServers = servers.filter(([_, info]) =>
      info.models.includes(model!)
    );

    if (availableServers.length === 0) {
      console.log(`[WARN] No servers support model '${model}'.`);
      res.writeHead(503);
      res.end("No servers support the requested model.");
      return;
    }

    let response: Response | null = null;

    // Attempt to find a responding server
    while (availableServers.length > 0) {
      availableServers.sort((a, b) => a[1].queue.length - b[1].queue.length);
      const [serverName, serverInfo] = availableServers[0];
      console.log(
        `[DEBUG] Checking server: ${serverName} at ${serverInfo.url}`
      );

      const serverAvailable = await isServerAvailable(serverInfo);
      if (!serverAvailable) {
        console.log(`[WARN] Server ${serverName} is not available.`);
        availableServers.shift();
        continue;
      }

      const queue = serverInfo.queue;
      console.log(
        `[DEBUG] Adding request to server ${serverName}'s queue (current length: ${queue.length})`
      );
      queue.push(1);

      try {
        console.log(`[DEBUG] Sending request to server ${serverName}`);
        response = await sendRequestWithRetries(
          serverInfo,
          req.method,
          pathName
            .replace("/api/completions", "/v1/chat/completions")
            .replace("/chat/completions", "/v1/chat/completions"),
          getParams,
          postData,
          backendHeaders,
          retryAttempts,
          serverInfo.timeout
        );
        if (response) {
          console.log(
            `[DEBUG] Response received from server ${serverName} with status ${response.status}`
          );
        } else {
          console.log(
            `[WARN] No response from server ${serverName} after retries`
          );
        }

        if (response) {
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
            console.log(
              "[DEBUG] Response body is a ReadableStream, pumping..."
            );
            const reader = response.body.getReader();
            await pump(res, reader);
          } else {
            const textBody = await response.text();
            res.end(textBody);
          }
          break;
        } else {
          availableServers.shift();
        }
      } catch (error: any) {
        availableServers.shift();
      } finally {
        queue.pop();
      }
    }

    if (!response) {
      res.writeHead(503);
      res.end("No available servers could handle the request.");
    }
  } else {
    if (servers.length === 0) {
      res.writeHead(503);
      res.end("No servers configured.");
      return;
    }

    const [_defaultServerName, defaultServerInfo] = servers[0];
    if (!(await isServerAvailable(defaultServerInfo))) {
      console.log("[WARN] Default server is not available.");
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
      console.log(
        `[DEBUG] Response received from default server with status ${response.status}`
      );
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
        await pump(res, reader);
      } else {
        const textBody = await response.text();
        res.end(textBody);
      }
    } else {
      console.log("[WARN] Failed to forward request to default server.");
      res.writeHead(503);
      res.end("Failed to forward request to default server.");
    }
  }
}
