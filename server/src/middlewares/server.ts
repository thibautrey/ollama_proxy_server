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
