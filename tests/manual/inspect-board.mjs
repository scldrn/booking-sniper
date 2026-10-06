const API_BASE_URL = "https://api.lcnidiomas.edu.co";
const WEB_ORIGIN = "https://usuarios.lcnidiomas.edu.co";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const combined = headers.get("set-cookie") ?? "";
  return combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g).filter(Boolean);
}

function addCookieHeaders(jar, headers) {
  for (const header of getSetCookieHeaders(headers)) {
    const pair = header.split(";", 1)[0]?.trim();
    const separator = pair?.indexOf("=");
    if (!pair || separator <= 0) continue;
    jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookiesValue(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function bogotaDateKey(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function request(path, init, jar, xsrfToken) {
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: cookiesValue(jar),
      "X-XSRF-TOKEN": xsrfToken,
      "X-Requested-With": "XMLHttpRequest",
      Origin: WEB_ORIGIN,
      Referer: `${WEB_ORIGIN}/`,
      ...(init.headers ?? {}),
    },
  });
}

async function run() {
  if (process.env.RUN_LIVE_DIAGNOSTICS !== "1") {
    throw new Error("Set RUN_LIVE_DIAGNOSTICS=1 to authorize a live, read-only board inspection");
  }

  const email = requiredEnv("LCN_EMAIL");
  const password = requiredEnv("LCN_PASSWORD");
  const headquarterId = process.env.LCN_HEADQUARTER_ID ?? "2";
  const languageId = process.env.LCN_LANGUAGE_ID ?? "70";
  const startDate = process.env.LCN_START_DATE ?? bogotaDateKey();
  const endDate = process.env.LCN_END_DATE ?? addDays(startDate, 3);
  const jar = new Map();

  const csrf = await request("/sanctum/csrf-cookie", { method: "GET" }, jar, "");
  if (!csrf.ok) throw new Error(`CSRF request failed with status ${csrf.status}`);
  addCookieHeaders(jar, csrf.headers);
  let xsrfToken = decodeURIComponent(jar.get("XSRF-TOKEN") ?? "");

  const login = await request(
    "/api/login",
    { method: "POST", body: JSON.stringify({ email, password }) },
    jar,
    xsrfToken,
  );
  if (!login.ok) throw new Error(`LCN login failed with status ${login.status}`);
  addCookieHeaders(jar, login.headers);
  xsrfToken = decodeURIComponent(jar.get("XSRF-TOKEN") ?? xsrfToken);

  const query = new URLSearchParams({ teachers: "[]" });
  const board = await request(
    `/api/schedules/between-dates/${encodeURIComponent(headquarterId)}/${encodeURIComponent(languageId)}/${startDate}/${endDate}?${query}`,
    { method: "GET" },
    jar,
    xsrfToken,
  );
  const body = await board.json();
  if (!board.ok) throw new Error(`Board request failed with status ${board.status}`);

  const classes = Array.isArray(body.data) ? body.data : [];
  console.log(`Board range: ${startDate} to ${endDate} (exclusive)`);
  console.log(`Schedules found: ${classes.length}`);
  for (const item of classes) {
    console.log(JSON.stringify({
      id: item.id,
      start_date: item.start_date,
      start_hour: item.start_hour,
      level: item.course_level_group_name,
      reserved: item.reserved,
      capacity: item.max_student,
    }));
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
