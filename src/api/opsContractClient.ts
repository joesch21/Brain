// src/api/opsContractClient.ts
// EWOT: Fetches and caches the API contract so the UI never guesses endpoints.

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

const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL;

if (!API_BASE) {
  throw new Error("VITE_API_BASE_URL is not set. Frontend cannot call API.");
}

let cachedContract: ApiContract | null = null;

export async function loadApiContract(): Promise<ApiContract> {
  if (cachedContract) return cachedContract;

  const res = await fetch(`${API_BASE}/contract`);
  if (!res.ok) {
    throw new Error(`Failed to load API contract (${res.status})`);
  }

  const contract = (await res.json()) as ApiContract;

  if (!Array.isArray(contract.endpoints)) {
    throw new Error("Invalid API contract: endpoints missing");
  }

  cachedContract = contract;
  return contract;
}

export async function getEndpoint(name: string): Promise<ApiEndpoint> {
  const contract = await loadApiContract();
  const ep = contract.endpoints.find(e => e.name === name);
  if (!ep) {
    throw new Error(`API endpoint '${name}' not declared in contract`);
  }
  return ep;
}
