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
  console.log("[DEBUG] Starting to pump response to client");
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      console.log(
        "[DEBUG] No more data from upstream, ending chunked response"
      );
      break;
    }
    if (value) {
      const chunkSize = value.length.toString(16).toUpperCase();
      console.log(
        `[DEBUG] Writing chunk of size: ${value.length}, hex size: ${chunkSize}`
      );
      res.write(chunkSize + "\r\n");
      res.write(value);
      res.write("\r\n");
    } else {
      console.log("[DEBUG] Reader returned empty value chunk, continuing...");
    }
  }
  res.write("0\r\n\r\n");
  res.end();
  console.log("[DEBUG] Finished pumping response");
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
  // console.log("[DEBUG] AI Handler configured");
  // console.log("[DEBUG] Servers:", servers);
  // console.log("[DEBUG] Authorized Users:", authorizedUsers);
  // console.log("[DEBUG] Retry Attempts:", retryAttempts);
  // console.log("[DEBUG] Deactivate Security:", deactivateSecurity);
}

async function isServerAvailable(serverInfo: ServerInfo): Promise<boolean> {
  const timeout = 2000;

  console.log(`[DEBUG] Checking availability of server: ${serverInfo.url}`);
  const timeoutPromise = new Promise<boolean>((resolve) => {
    setTimeout(() => {
      console.log("[DEBUG] Availability check timed out");
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
  console.log("[DEBUG] sendRequestWithRetries called");
  const url = new URL(serverInfo.url + fullPath);

  // Append query parameters to the URL
  for (const [key, values] of Object.entries(query)) {
    for (const value of values) {
      url.searchParams.append(key, value);
    }
  }

  console.log(`[DEBUG] Final request URL: ${url.toString()}`);

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
    // @ts-ignore
    console.log("[DEBUG] Request has a POST/PUT/PATCH body:", options.body);
  }

  for (let i = 0; i < attempts; i++) {
    console.log(
      `[DEBUG] Attempt ${i + 1} of ${attempts} forwarding request to ${
        url.href
      }`
    );

    try {
      // @ts-ignore
      const fetchPromise = fetch(url.toString(), options);
      const timeoutPromise = new Promise<Response>((_, reject) =>
        setTimeout(() => {
          console.log(
            `[DEBUG] Request to ${url.href} timed out after ${timeout}s`
          );
          reject(new Error("Timeout"));
        }, timeout * 1000)
      );

      const response = (await Promise.race([
        fetchPromise,
        timeoutPromise,
      ])) as Response;
      console.log(
        `[DEBUG] Received response from ${url.href} with status code ${response.status}`
      );
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
  console.log("[DEBUG] Starting handleAiRequest");
  const clientIp = req.socket.remoteAddress;
  const clientPort = req.socket.remotePort;
  let user = "unknown";

  console.log(`[DEBUG] Client: ${clientIp}:${clientPort}`);
  console.log("[DEBUG] Incoming request headers:", req.headers);
  console.log(`[DEBUG] Request method: ${req.method}, URL: ${req.url}`);

  // Handle authorization if security is not deactivated
  if (!deactivateSecurity) {
    console.log("[DEBUG] Security is activated, checking authorization...");
    const authHeader = req.headers["authorization"];
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
    console.log(`[DEBUG] Checking token for user: ${u}`);
    if (authorizedUsers[u] !== k) {
      console.log("[WARN] User is not authorized: Incorrect token");
      res.writeHead(403);
      res.end();
      return;
    }
    user = `${u}`;
    console.log(`[DEBUG] User ${user} authorized successfully.`);
  } else {
    console.log("[DEBUG] Security deactivated, skipping auth checks.");
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

  console.log("[DEBUG] Parsed URL and query");
  console.log(`[DEBUG] Path: ${pathName}`);
  console.log(`[DEBUG] Query Params: ${JSON.stringify(getParams)}`);

  // Parse POST data if applicable
  let postData: PostData = {};
  if (req.method === "POST") {
    console.log("[DEBUG] Request is POST, collecting body data...");
    const body: string = await new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => {
        console.log("[DEBUG] Received chunk of POST data");
        data += chunk;
      });
      req.on("end", () => {
        console.log("[DEBUG] POST body collection complete");
        resolve(data);
      });
      req.on("error", (err) => {
        console.log(`[ERROR] Error receiving POST body: ${err}`);
      });
    });

    try {
      postData = JSON.parse(body);
      console.log(`[DEBUG] POST data: ${JSON.stringify(postData)}`);
    } catch (e: any) {
      console.log(`[ERROR] Failed to decode POST data: ${e}`);
      postData = {};
    }
  } else {
    console.log("[DEBUG] Request is not POST, no body to parse.");
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
  ];

  // Prepare headers to forward to backend
  const backendHeaders: http.IncomingHttpHeaders = { ...req.headers };
  delete backendHeaders["authorization"];
  delete backendHeaders["host"];
  console.log("[DEBUG] Backend headers:", backendHeaders);

  if (modelBasedEndpoints.includes(pathName)) {
    console.log("[DEBUG] Handling a model-based endpoint.");
    if (!model) {
      console.log("[WARN] Missing 'model' in request");
      res.writeHead(400);
      res.end("Missing 'model' in request");
      return;
    }

    console.log("[DEBUG] Filtering servers by requested model");
    let availableServers = servers.filter(([_, info]) =>
      info.models.includes(model!)
    );
    console.log(
      `[DEBUG] Servers supporting model '${model}': ${availableServers
        .map((s) => s[0])
        .join(", ")}`
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
          pathName,
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
          console.log("[DEBUG] Preparing to stream response to client");
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
          console.log("[DEBUG] Response headers to client:", headersToSend);
          res.writeHead(response.status, headersToSend);

          if (response.body instanceof ReadableStream) {
            console.log(
              "[DEBUG] Response body is a ReadableStream, pumping..."
            );
            const reader = response.body.getReader();
            await pump(res, reader);
            console.log("[DEBUG] Finished pumping response to client");
          } else {
            console.log(
              "[DEBUG] Response body is not a ReadableStream, ending response"
            );
            const textBody = await response.text();
            res.end(textBody);
          }
          break;
        } else {
          console.log(
            `[WARN] All retries failed for server ${serverName}, removing from availableServers`
          );
          availableServers.shift();
        }
      } catch (error: any) {
        console.log(
          `[ERROR] Error while sending request to ${serverName}: ${error}`
        );
        availableServers.shift();
      } finally {
        queue.pop();
        console.log(
          `[DEBUG] Removed request from ${serverName}'s queue (new length: ${queue.length})`
        );
      }
    }

    if (!response) {
      console.log(
        "[WARN] No server could handle the request after all attempts."
      );
      res.writeHead(503);
      res.end("No available servers could handle the request.");
    } else {
      console.log("[DEBUG] Response successfully sent to client.");
    }
  } else {
    console.log("[DEBUG] Handling a non-model endpoint.");
    if (servers.length === 0) {
      console.log("[WARN] No servers configured.");
      res.writeHead(503);
      res.end("No servers configured.");
      return;
    }

    const [_defaultServerName, defaultServerInfo] = servers[0];
    console.log("[DEBUG] Checking default server availability");
    if (!(await isServerAvailable(defaultServerInfo))) {
      console.log("[WARN] Default server is not available.");
      res.writeHead(503);
      res.end("Default server is not available.");
      return;
    }

    console.log("[DEBUG] Sending request to default server");
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
      console.log("[DEBUG] Response headers to client:", headersToSend);
      res.writeHead(response.status, headersToSend);

      if (response.body instanceof ReadableStream) {
        console.log(
          "[DEBUG] Response body is a ReadableStream for default server, pumping..."
        );
        const reader = response.body.getReader();
        await pump(res, reader);
        console.log(
          "[DEBUG] Finished streaming default server response to client"
        );
      } else {
        console.log(
          "[DEBUG] Response body is not a ReadableStream for default server, reading text"
        );
        const textBody = await response.text();
        res.end(textBody);
      }
    } else {
      console.log("[WARN] Failed to forward request to default server.");
      res.writeHead(503);
      res.end("Failed to forward request to default server.");
    }
  }

  console.log("[DEBUG] handleAiRequest complete.");
}
