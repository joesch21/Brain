export async function opsGet(url) {
  return fetch(url, { credentials: "include" });
}

export async function opsPost(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
}
