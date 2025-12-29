// src/api/opsContractClient.ts
// EWOT: Fetches and caches the API contract so the UI never guesses endpoints.

import { joinApi } from "../config/apiBase";

export type ApiEndpoint = {
  name: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
};

export type ApiContract = {
  service_name: string;
  environment: string;
  version: string;
  api_base_hint: string;
  endpoints: ApiEndpoint[];
};

const CONTRACT_PATH = "/api/contract";

let cachedContract: ApiContract | null = null;

async function fetchContract(url: string): Promise<ApiContract> {
  const res = await fetch(url);
  if (!res.ok) {
    const error = new Error(`Failed to load API contract (${res.status})`);
    (error as Error & { status?: number }).status = res.status;
    throw error;
  }

  const contract = (await res.json()) as ApiContract;

  if (!Array.isArray(contract.endpoints)) {
    throw new Error("Invalid API contract: endpoints missing");
  }

  return contract;
}

export async function loadApiContract(): Promise<ApiContract> {
  if (cachedContract) return cachedContract;

  try {
    const contract = await fetchContract(joinApi(CONTRACT_PATH));
    cachedContract = contract;
    return contract;
  } catch (primaryError) {
    throw primaryError;
  }
}

export async function getEndpoint(name: string): Promise<ApiEndpoint> {
  const contract = await loadApiContract();
  const ep = contract.endpoints.find(e => e.name === name);
  if (!ep) {
    throw new Error(`API endpoint '${name}' not declared in contract`);
  }
  return ep;
}
