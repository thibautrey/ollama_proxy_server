import * as express from "express";
import {
  createServer,
  listServers,
  getServerById,
  updateServer,
  deleteServer,
  getServerByUrl,
  addModelToServer,
} from "../middlewares/server.js";
import { listUsers, getUserByUsername } from "../middlewares/user.js";

const router = express.Router();

// Middleware to parse JSON
router.use(express.json());

// A helper function to extract the bearer token in the form "username:key"
function extractCredentialsFromHeader(
  req: any
): { username: string; key: string } | null {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring("Bearer ".length);
  const parts = token.split(":");
  if (parts.length !== 2) return null;

  const [username, key] = parts;
  return { username, key };
}

// Determine if the request is authorized to use server endpoints
// Only the first created user can use these endpoints.
async function canAccessServers(req: any): Promise<boolean> {
  const users = await listUsers();
  if (users.length === 0) {
    // No users exist yet. We have no "first user" to give permission to.
    // If desired, you could allow access in this scenario.
    // For now, we disallow since there's no first user.
    return false;
  }

  // If there are users, only the first created user can use these endpoints.
  const firstUser = [...users].sort((a, b) => a.id.localeCompare(b.id))[0];

  const credentials = extractCredentialsFromHeader(req);
  if (!credentials) return false;

  const foundUser = await getUserByUsername(credentials.username);
  if (!foundUser) return false;

  return (
    foundUser.username === firstUser!.username &&
    foundUser.key === credentials.key
  );
}

// POST /servers - create a new server (only first user)
router.post("/", async (req: any, res: any) => {
  if (!(await canAccessServers(req))) {
    return res.status(403).json({ error: "Not authorized to create servers" });
  }

  const { url, queueSize, isDefault } = req.body;

  if (!url || typeof queueSize !== "number") {
    return res
      .status(400)
      .json({ error: "Missing or invalid url or queueSize" });
  }

  try {
    const newServer = await createServer(url, queueSize, isDefault ?? false);
    return res.status(201).json(newServer);
  } catch (err: any) {
    return res
      .status(500)
      .json({ error: err.message || "Failed to create server" });
  }
});

// GET /servers - list all servers (only first user)
router.get("/", async (req: any, res: any) => {
  if (!(await canAccessServers(req))) {
    return res.status(403).json({ error: "Not authorized to list servers" });
  }

  try {
    const servers = await listServers();
    return res.json(servers);
  } catch (err: any) {
    return res
      .status(500)
      .json({ error: err.message || "Failed to list servers" });
  }
});

// GET /servers/:id - get a single server by ID (only first user)
router.get("/:id", async (req: any, res: any) => {
  if (!(await canAccessServers(req))) {
    return res.status(403).json({ error: "Not authorized to get server info" });
  }

  const { id } = req.params;

  try {
    const server = await getServerById(id);
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }
    return res.json(server);
  } catch (err: any) {
    return res
      .status(500)
      .json({ error: err.message || "Failed to retrieve server" });
  }
});

// GET /servers/url/:url - get a single server by URL (only first user)
router.get("/url/:url", async (req: any, res: any) => {
  if (!(await canAccessServers(req))) {
    return res.status(403).json({ error: "Not authorized to get server info" });
  }

  const { url } = req.params;

  try {
    const server = await getServerByUrl(url);
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }
    return res.json(server);
  } catch (err: any) {
    return res
      .status(500)
      .json({ error: err.message || "Failed to retrieve server by URL" });
  }
});

// PUT /servers/:id - update a server (only first user)
router.put("/:id", async (req: any, res: any) => {
  if (!(await canAccessServers(req))) {
    return res.status(403).json({ error: "Not authorized to update server" });
  }

  const { id } = req.params;
  const data = req.body;

  try {
    const updatedServer = await updateServer(id, data);
    return res.json(updatedServer);
  } catch (err: any) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Server not found" });
    }
    return res
      .status(500)
      .json({ error: err.message || "Failed to update server" });
  }
});

// DELETE /servers/:id - delete a server (only first user)
router.delete("/:id", async (req: any, res: any) => {
  if (!(await canAccessServers(req))) {
    return res.status(403).json({ error: "Not authorized to delete server" });
  }

  const { id } = req.params;

  try {
    const deletedServer = await deleteServer(id);
    return res.json(deletedServer);
  } catch (err: any) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Server not found" });
    }
    return res
      .status(500)
      .json({ error: err.message || "Failed to delete server" });
  }
});

// POST /servers/:id/models - associate a model to a server (only first user)
router.post("/:id/models", async (req: any, res: any) => {
  if (!(await canAccessServers(req))) {
    return res
      .status(403)
      .json({ error: "Not authorized to add models to server" });
  }

  const { id } = req.params;
  const { modelName } = req.body;

  if (!modelName || typeof modelName !== "string") {
    return res.status(400).json({ error: "Missing or invalid modelName" });
  }

  try {
    const updatedServer = await addModelToServer(id, modelName);
    return res.status(200).json(updatedServer);
  } catch (err: any) {
    if (err.message.includes("does not exist")) {
      return res.status(404).json({ error: err.message });
    }
    return res
      .status(500)
      .json({ error: err.message || "Failed to add model to server" });
  }
});

export default router;
