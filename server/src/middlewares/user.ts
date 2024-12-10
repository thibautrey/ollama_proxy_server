import { User } from "@prisma/client";

import { prisma } from "./prismaClient.js";

export async function createUser(username: string, key: string): Promise<User> {
  return prisma.user.create({
    data: { username, key },
  });
}

export async function getUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({
    where: { id },
  });
}

export async function getUserByUsername(
  username: string
): Promise<User | null> {
  return prisma.user.findUnique({
    where: { username },
  });
}

export async function updateUser(
  id: string,
  data: Partial<User>
): Promise<User> {
  return prisma.user.update({
    where: { id },
    data,
  });
}

export async function deleteUser(id: string): Promise<User> {
  return prisma.user.delete({
    where: { id },
  });
}

export async function listUsers(): Promise<User[]> {
  return prisma.user.findMany();
}
