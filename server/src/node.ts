import { Request, Response, NextFunction } from "express";
import express from "express";
import * as http from "http";

import { getAuthorizedUsers, getConfig } from "./middlewares/config.js";
import { configureAiHandler, handleAiRequest } from "./routes/aiHandler.js";
import userRoutes from "./routes/user.js";
import modelRoutes from "./routes/model.js";
import serverRoutes from "./routes/server.js";

// ------------------------------------------------------------
// Command-Line Arguments and Configuration
// ------------------------------------------------------------
let servers: ServersType = [];
let authorizedUsers: AuthorizedUsers = {};

// ------------------------------------------------------------
// Periodic Refresh of Servers and Authorized Users
// ------------------------------------------------------------
async function refreshData() {
  try {
    servers = await getConfig(); // Fetch servers from database
    authorizedUsers = await getAuthorizedUsers(); // Fetch users from database
    console.log("Refreshed servers and authorized users from database.");

    // Update the AI handler configuration
    configureAiHandler(servers, authorizedUsers, 3, false);
  } catch (err) {
    console.error("Error refreshing data from database:", err);
  }
}

(async () => {
  // Initial load
  await refreshData();
  // Refresh every 10 seconds (adjust as needed)
  setInterval(refreshData, 10000);
})();

const app = express();

app.use("/users", userRoutes);
app.use("/models", modelRoutes);
app.use("/servers", serverRoutes);

// For all other routes, use the AI handler
app.use(async (req: Request, res: Response, next: NextFunction) => {
  const nodeReq = req as unknown as http.IncomingMessage;
  const nodeRes = res as unknown as http.ServerResponse;
  try {
    await handleAiRequest(nodeReq, nodeRes);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// Server Startup and Shutdown
// ------------------------------------------------------------
console.log("Ollama Proxy server");
console.log("Author: thibautrey");
console.log("Starting server");

app.listen(8080, () => {
  console.log(`Running server on port 8080`);
});

process.on("SIGINT", () => {
  console.log("Shutting down the server.");
  process.exit(0);
});
