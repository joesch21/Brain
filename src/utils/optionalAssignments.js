import { fetchJson } from "./api";

const ASSIGNMENTS_CACHE = new Map();
const DEFAULT_TIMEOUT_MS = 5000;

function buildCacheKey({ date, airport, operator, shift }) {
  return [date, airport, operator || "", shift || ""].join("|");
}

function createTimeoutSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timeoutId = null;

  const handleAbort = () => controller.abort();

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener("abort", handleAbort);
    }
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  return {
    signal: controller.signal,
    clear: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (parentSignal) {
        parentSignal.removeEventListener("abort", handleAbort);
      }
    },
  };
}

function normalizeAssignmentsResponse(data) {
  if (Array.isArray(data?.assignments)) return data.assignments;
  if (Array.isArray(data)) return data;
  return [];
}

async function fetchAssignments({
  date,
  airport,
  operator,
  shift,
  timeoutMs,
  signal,
}) {
  if (!date || !airport) {
    return { ok: false, error: "missing_params" };
  }

  if (signal?.aborted) {
    return { ok: false, error: "aborted" };
  }

  const params = new URLSearchParams({
    date,
    airport,
  });

  if (operator && operator !== "ALL") {
    params.set("airline", operator);
  }

  if (shift && shift !== "ALL") {
    params.set("shift", shift);
  }

  const { signal: timeoutSignal, clear } = createTimeoutSignal(
    signal,
    timeoutMs,
  );

  try {
    const res = await fetchJson(
      `/api/employee_assignments/daily?${params.toString()}`,
      { signal: timeoutSignal },
    );

    if (timeoutSignal.aborted) {
      return { ok: false, error: signal?.aborted ? "aborted" : "timeout" };
    }

    if (!res?.ok) {
      if (res?.status === 404) {
        return { ok: false, error: "not_found" };
      }
      return { ok: false, error: "http" };
    }

    return {
      ok: true,
      assignments: normalizeAssignmentsResponse(res.data),
    };
  } catch (err) {
    if (timeoutSignal.aborted) {
      return { ok: false, error: signal?.aborted ? "aborted" : "timeout" };
    }
    return { ok: false, error: "http" };
  } finally {
    clear();
  }
}

export async function getAssignmentsOptional({
  date,
  airport,
  operator,
  shift,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
}) {
  const cacheKey = buildCacheKey({ date, airport, operator, shift });
  const cached = ASSIGNMENTS_CACHE.get(cacheKey);

  if (cached) {
    if (cached.status === "resolved") {
      return cached.value;
    }
    if (cached.status === "pending") {
      return cached.promise;
    }
  }

  const promise = fetchAssignments({
    date,
    airport,
    operator,
    shift,
    timeoutMs,
    signal,
  });

  ASSIGNMENTS_CACHE.set(cacheKey, { status: "pending", promise });

  const result = await promise;

  if (result?.error === "aborted") {
    ASSIGNMENTS_CACHE.delete(cacheKey);
  } else {
    ASSIGNMENTS_CACHE.set(cacheKey, { status: "resolved", value: result });
  }

  return result;
}
