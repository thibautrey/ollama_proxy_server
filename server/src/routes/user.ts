import * as express from "express";
import {
  createUser,
  listUsers,
  getUserByUsername,
} from "../middlewares/user.js";

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

// Determine if the request is authorized to create a user
async function canCreateUsers(req: Request): Promise<boolean> {
  const users = await listUsers();
  if (users.length === 0) {
    // No users yet, anyone can create
    return true;
  }

  // If there are users, only the first created user can create new ones.
  // We'll assume the first user is the one with the lexically smallest id.
  const firstUser = [...users].sort((a, b) => a.id.localeCompare(b.id))[0];

  const credentials = extractCredentialsFromHeader(req);
  if (!credentials) return false;

  const foundUser = await getUserByUsername(credentials.username);
  if (!foundUser) return false;

  // Check if this found user matches the first created user's username and key
  return (
    foundUser.username === firstUser!.username &&
    foundUser.key === credentials.key
  );
}

// POST /users - create a new user
router.post("/", async (req: any, res: any) => {
  const { username, key } = req.body;

  if (!username || !key) {
    return res.status(400).json({ error: "Missing username or key" });
  }

  // Check if we can create users under the current conditions
  if (!(await canCreateUsers(req))) {
    return res.status(403).json({ error: "Not authorized to create users" });
  }

  // Attempt to create the user
  try {
    const newUser = await createUser(username, key);
    return res.status(201).json(newUser);
  } catch (err: any) {
    return res
      .status(500)
      .json({ error: err.message || "Failed to create user" });
  }
});

// GET /users - list all users
router.get("/", async (_req: any, res: any) => {
  try {
    const users = await listUsers();
    return res.json(users);
  } catch (err: any) {
    return res
      .status(500)
      .json({ error: err.message || "Failed to list users" });
  }
});

export default router;
