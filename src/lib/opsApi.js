import { joinApi } from "../config/apiBase";

export async function opsGet(path) {
  const url = joinApi(path);
  return fetch(url, { credentials: "include" });
}

export async function opsPost(path, body) {
  const url = joinApi(path);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
}
