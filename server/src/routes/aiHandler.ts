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

  // Handle authorization if security is not deactivated
  if (!deactivateSecurity) {
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.log("User is not authorized");
      // addAccessLogEntry(
      //   "rejected",
      //   "unknown",
      //   clientIp || null,
      //   "Denied",
      //   "None",
      //   -1,
      //   "Authentication failed"
      // );
      res.writeHead(403);
      res.end();
      return;
    }

    const token = authHeader.substring("Bearer ".length);
    const parts = token.split(":");
    if (parts.length !== 2) {
      console.log("User is not authorized");
      // addAccessLogEntry(
      //   "rejected",
      //   token,
      //   clientIp || null,
      //   "Denied",
      //   "None",
      //   -1,
      //   "Authentication failed"
      // );
      res.writeHead(403);
      res.end();
      return;
    }

    const [u, k] = parts;
    if (!u) return;
    if (authorizedUsers[u] !== k) {
      console.log("User is not authorized");
      // addAccessLogEntry(
      //   "rejected",
      //   token,
      //   clientIp || null,
      //   "Denied",
      //   "None",
      //   -1,
      //   "Authentication failed"
      // );
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
      if (!availableServers[0]) return;
      const [serverName, serverInfo] = availableServers[0];

      if (!(await isServerAvailable(serverInfo))) {
        console.log(`Server ${serverName} is not available.`);
        availableServers.shift();
        continue;
      }

      const queue = serverInfo.queue;

      // Simulate add to queue
      queue.push(1);
      // addAccessLogEntry(
      //   "gen_request",
      //   user,
      //   clientIp || null,
      //   "Authorized",
      //   serverName,
      //   queue.length
      // );

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

            await pump(res, reader);
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
        // addAccessLogEntry(
        //   "gen_done",
        //   user,
        //   clientIp || null,
        //   "Authorized",
        //   serverName,
        //   queue.length
        // );
      }
    }

    if (!response) {
      // No server could handle the request
      res.writeHead(503);
      res.end("No available servers could handle the request.");
    }
  } else {
    // Non-model endpoints: Use default server
    if (!servers[0]) return;
    const [_defaultServerName, defaultServerInfo] = servers[0];

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

        await pump(res, reader);
      }
    } else {
      res.writeHead(503);
      res.end("Failed to forward request to default server.");
    }
  }
}
