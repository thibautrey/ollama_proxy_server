import { Server } from "@prisma/client";
import { prisma } from "./prismaClient.js";

export async function createServer(
  url: string,
  queueSize: number,
  isDefault: boolean = false
): Promise<Server> {
  return prisma.server.create({
    data: { url, queueSize, isDefault },
  });
}

export async function getServerById(id: string): Promise<Server | null> {
  return prisma.server.findUnique({
    where: { id },
    include: { models: true },
  });
}

export async function getServerByUrl(url: string): Promise<Server | null> {
  return prisma.server.findUnique({
    where: { url },
    include: { models: true },
  });
}

export async function updateServer(
  id: string,
  data: Partial<Server>
): Promise<Server> {
  return prisma.server.update({
    where: { id },
    data,
    include: { models: true },
  });
}

export async function deleteServer(id: string): Promise<Server> {
  return prisma.server.delete({
    where: { id },
  });
}

export async function listServers(): Promise<Server[]> {
  return prisma.server.findMany({ include: { models: true } });
}

/**
 * Associates a model (by name) to a given server if not already associated.
 * Throws an error if the server or model does not exist.
 */
export async function addModelToServer(
  serverId: string,
  modelName: string
): Promise<Server> {
  // Verify that the model exists
  const model = await prisma.model.findFirst({
    where: {
      name: modelName,
    },
  });
  if (!model) {
    throw new Error(`Model with name "${modelName}" does not exist.`);
  }

  // Fetch the server and its models
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { models: true },
  });
  if (!server) {
    throw new Error(`Server with ID "${serverId}" does not exist.`);
  }

  // Check if the model is already associated
  const isAlreadyAssociated = server.models.some((m) => m.id === model.id);
  if (isAlreadyAssociated) {
    return server;
  }

  // Associate the model
  return prisma.server.update({
    where: { id: serverId },
    data: {
      models: {
        connect: { id: model.id },
      },
    },
    include: { models: true },
  });
}
