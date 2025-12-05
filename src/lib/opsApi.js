import { OPS_API_BASE } from "./opsApiBase";

export async function opsGet(path) {
  const url = `${OPS_API_BASE}${path}`;
  return fetch(url, { credentials: "include" });
}

export async function opsPost(path, body) {
  const url = `${OPS_API_BASE}${path}`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
}
