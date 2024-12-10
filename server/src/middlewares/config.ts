import { prisma } from "./prismaClient.js";

/**
 * Fetch servers from the Prisma database and map them to the ServersType format.
 * The returned structure will mimic what was previously loaded from the INI file.
 *
 * @param defaultTimeout - The default timeout to use for each server (since not defined in schema)
 */
async function getConfig(defaultTimeout = 300): Promise<ServersType> {
  // Fetch all servers along with their related models
  const dbServers = await prisma.server.findMany({
    include: { models: true },
  });

  const servers: ServersType = dbServers.map((server) => {
    // Extract model names from the server's associated models
    const modelNames = server.models.map((m) => m.name);

    // Build the ServerInfo object
    const serverInfo: ServerInfo = {
      url: server.url,
      queue: [],
      models: modelNames,
      timeout: defaultTimeout, // hard-coded since not in schema
    };

    // Use the server's URL or ID as the key. Previously,
    // the key was the section name from the ini. Here we use the URL.
    return [server.url, serverInfo] as [string, ServerInfo];
  });

  return servers;
}

/**
 * Fetch authorized users from the Prisma database and return them
 * as a dictionary of { username: key } pairs.
 */
async function getAuthorizedUsers(): Promise<AuthorizedUsers> {
  const dbUsers = await prisma.user.findMany();

  const authorizedUsers: AuthorizedUsers = {};
  for (const user of dbUsers) {
    authorizedUsers[user.username] = user.key;
  }

  return authorizedUsers;
}

export { getAuthorizedUsers, getConfig };
