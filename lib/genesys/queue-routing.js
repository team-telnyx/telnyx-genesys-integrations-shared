import { getRoutingApi } from "./client.js";

export class GenesysQueueNotFoundError extends Error {
  constructor(queueName) {
    super(`Genesys Cloud queue "${queueName}" does not exist`);
    this.name = "GenesysQueueNotFoundError";
    this.code = "GENESYS_QUEUE_NOT_FOUND";
    this.status = 404;
    this.queueName = queueName;
  }
}

export function normalizeGenesysQueueName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 200);
}

export function selectGenesysQueueByName(queues, requestedName) {
  const queueName = normalizeGenesysQueueName(requestedName);
  if (!queueName) throw new Error("queue_name is required");

  const exact = (Array.isArray(queues) ? queues : []).filter(
    (queue) => normalizeGenesysQueueName(queue?.name).toLocaleLowerCase() ===
      queueName.toLocaleLowerCase()
  );
  if (exact.length === 0) throw new GenesysQueueNotFoundError(queueName);
  if (exact.length > 1) {
    throw new Error(`Genesys Cloud queue name "${queueName}" is ambiguous`);
  }
  return exact[0];
}

export async function findGenesysQueueByName(requestedName) {
  const queueName = normalizeGenesysQueueName(requestedName);
  if (!queueName) throw new Error("queue_name is required");

  const routingApi = await getRoutingApi();
  const response = await routingApi.getRoutingQueues({
    name: queueName,
    pageNumber: 1,
    pageSize: 100,
  });
  return selectGenesysQueueByName(response?.entities, queueName);
}
