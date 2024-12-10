import * as express from "express";
import {
  createModel,
  listModels,
  getModelById,
  updateModel,
  deleteModel,
} from "../middlewares/model.js";
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

// Determine if the Request is authorized to modify models
async function canModifyModels(req: Request): Promise<boolean> {
  const users = await listUsers();
  if (users.length === 0) {
    // No users yet, no modifications allowed because we do not know who the first user is.
    // You could decide that if no user exists yet, no modifications are allowed, or anyone can.
    // For this example, let's say anyone can if no users exist.
    // If you prefer stricter logic, you can return false if no user exists.
    return true;
  }

  // If there are users, only the first created user can modify models.
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

// POST /models - create a new model (only first user)
router.post("/", async (req: any, res: any) => {
  if (!(await canModifyModels(req))) {
    return res.status(403).json({ error: "Not authorized to create models" });
  }

  const { name, size, serverId } = req.body;

  if (!name || typeof size !== "number") {
    return res.status(400).json({ error: "Missing or invalid name or size" });
  }

  try {
    const newModel = await createModel(name, size, serverId);
    return res.status(201).json(newModel);
  } catch (err: any) {
    return res
      .status(500)
      .json({ error: err.message || "Failed to create model" });
  }
});

// GET /models - list all models (public, no authorization required)
router.get("/", async (_req: any, res: any) => {
  try {
    const models = await listModels();
    return res.json(models);
  } catch (err: any) {
    return res
      .status(500)
      .json({ error: err.message || "Failed to list models" });
  }
});

// GET /models/:id - get a single model by ID (public, no authorization required)
router.get("/:id", async (req: any, res: any) => {
  const { id } = req.params;

  try {
    const model = await getModelById(id);
    if (!model) {
      return res.status(404).json({ error: "Model not found" });
    }
    return res.json(model);
  } catch (err: any) {
    return res
      .status(500)
      .json({ error: err.message || "Failed to retrieve model" });
  }
});

// PUT /models/:id - update a model (only first user)
router.put("/:id", async (req: any, res: any) => {
  if (!(await canModifyModels(req))) {
    return res.status(403).json({ error: "Not authorized to update models" });
  }

  const { id } = req.params;
  const data = req.body;

  try {
    const updatedModel = await updateModel(id, data);
    return res.json(updatedModel);
  } catch (err: any) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Model not found" });
    }
    return res
      .status(500)
      .json({ error: err.message || "Failed to update model" });
  }
});

// DELETE /models/:id - delete a model (only first user)
router.delete("/:id", async (req: any, res: any) => {
  if (!(await canModifyModels(req))) {
    return res.status(403).json({ error: "Not authorized to delete models" });
  }

  const { id } = req.params;

  try {
    const deletedModel = await deleteModel(id);
    return res.json(deletedModel);
  } catch (err: any) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Model not found" });
    }
    return res
      .status(500)
      .json({ error: err.message || "Failed to delete model" });
  }
});

export default router;
