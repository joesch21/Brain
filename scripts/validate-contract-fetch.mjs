const uiBase = process.env.UI_BASE_URL || "http://127.0.0.1:5173";
const base = uiBase.replace(/\/$/, "");
const contractUrl = `${base}/api/contract`;

console.log(`Validating contract fetch from ${contractUrl}`);

let res;
try {
  res = await fetch(contractUrl);
} catch (error) {
  console.error("Contract fetch failed", error);
  process.exit(1);
}

if (!res.ok) {
  console.error(`Contract fetch failed (${res.status})`);
  process.exit(1);
}

const contract = await res.json();

if (!Array.isArray(contract.endpoints)) {
  console.error("Contract validation failed: endpoints missing");
  process.exit(1);
}

if (contract.api_base_hint !== "/api") {
  console.error(`Contract validation failed: api_base_hint is '${contract.api_base_hint}'`);
  process.exit(1);
}

console.log(
  `Contract OK: ${contract.service_name} ${contract.environment} ${contract.version} (${contract.endpoints.length} endpoints)`
);
