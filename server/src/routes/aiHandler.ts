import * as http from "http";
import { parse as parseUrl } from "url";
import { parse as parseQuery } from "querystring";
import fetch, { Response } from "node-fetch";

// We'll receive these values from the main file
let servers: ServersType = [];
let authorizedUsers: AuthorizedUsers = {};
let retryAttempts = 3;
let deactivateSecurity = false;

async function pump(res, reader) {
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

  const timeoutPromise = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), timeout);
  });

  try {
    const fetchPromise = fetch(serverInfo.url, { method: "GET" }).then(
      (res) => res.ok
    );
    return await Promise.race([fetchPromise, timeoutPromise]);
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

  // Append query parameters to the URL
  Object.entries(query).forEach(([key, values]) => {
    values.forEach((value) => url.searchParams.append(key, value));
  });

  // Create request options
  const options: RequestInit = {
    method,
    // @ts-ignore
    headers: { ...headers },
  };

  if (["POST", "PUT", "PATCH"].includes(method || "") && postData) {
    options.body = JSON.stringify(postData);
    options.headers = {
      ...options.headers,
      "Content-Type": options.headers["Content-Type"] || "application/json",
    };
  }

  for (let i = 0; i < attempts; i++) {
    console.log(`Attempt ${i + 1} forwarding request to ${url.href}`);

    try {
      // @ts-ignore
      const fetchPromise = fetch(url.toString(), options);

      const timeoutPromise = new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), timeout * 1000)
      );

      const response = await Promise.race([fetchPromise, timeoutPromise]);

      console.log(`Received response with status code ${response.status}`);
      return response;
    } catch (err) {
      if (err.message === "Timeout") {
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

  console.log("[DEBUG] Starting handleAiRequest");
  console.log(`[DEBUG] Client: ${clientIp}:${clientPort}`);

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
        data += chunk;
      });
      req.on("end", () => {
        console.log("[DEBUG] POST body collection complete");
        resolve(data);
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

  if (modelBasedEndpoints.includes(pathName)) {
    console.log("[DEBUG] Handling a model-based endpoint.");
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

    console.log(
      `[DEBUG] Available servers for model '${model}': ${availableServers
        .map((s) => s[0])
        .join(", ")}`
    );

    let response: Response | null = null;

    // Attempt to find a responding server
    while (availableServers.length > 0) {
      availableServers.sort((a, b) => a[1].queue.length - b[1].queue.length);
      const [serverName, serverInfo] = availableServers[0];
      console.log(`[DEBUG] Checking server: ${serverName}`);

      if (!(await isServerAvailable(serverInfo))) {
        console.log(`[WARN] Server ${serverName} is not available.`);
        availableServers.shift();
        continue;
      }

      const queue = serverInfo.queue;
      console.log(`[DEBUG] Adding request to server ${serverName}'s queue`);
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
        console.log(`[DEBUG] Response received from server ${serverName}`);

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
          res.writeHead(response.status, headersToSend);

          if (response.body instanceof ReadableStream) {
            console.log(
              "[DEBUG] Response body is a ReadableStream, pumping..."
            );
            const reader = response.body.getReader();
            await pump(res, reader);
            console.log("[DEBUG] Finished pumping response to client");
          } else {
            console.log("[DEBUG] Response body is not a ReadableStream.");
          }
          break;
        } else {
          console.log(`[WARN] All retries failed for server ${serverName}`);
          availableServers.shift();
        }
      } catch (error: any) {
        console.log(
          `[ERROR] Error while sending request to ${serverName}: ${error}`
        );
        availableServers.shift();
      } finally {
        queue.pop();
        console.log(`[DEBUG] Removed request from ${serverName}'s queue`);
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
    const [_defaultServerName, defaultServerInfo] = servers[0];

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
        "[DEBUG] Response received from default server, streaming to client"
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
        console.log(
          "[DEBUG] Response body is a ReadableStream for default server"
        );
        const reader = response.body.getReader();
        await pump(res, reader);
        console.log(
          "[DEBUG] Finished streaming default server response to client"
        );
      } else {
        console.log(
          "[DEBUG] Response body is not a ReadableStream for default server"
        );
      }
    } else {
      console.log("[WARN] Failed to forward request to default server.");
      res.writeHead(503);
      res.end("Failed to forward request to default server.");
    }
  }

  console.log("[DEBUG] handleAiRequest complete.");
}
