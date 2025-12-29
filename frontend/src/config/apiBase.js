import { apiUrl, getApiBase as getBase } from "../lib/apiBase";

export function getApiBase() {
  return getBase();
}

export function joinApi(path) {
  return apiUrl(path);
}
