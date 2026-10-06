import type { BookingConfig, JsonObject, Schedule } from "./types.ts";

const API_BASE_URL = "https://api.lcnidiomas.edu.co";
const WEB_ORIGIN = "https://usuarios.lcnidiomas.edu.co";

interface ClientOptions {
  timeoutMs: number;
}

export interface LcnResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

export class LcnApiError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: unknown) {
    super(message);
    this.name = "LcnApiError";
  }
}

function splitSetCookieHeader(value: string): string[] {
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g);
}

function setCookieHeaders(headers: Headers): string[] {
  const candidate = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof candidate.getSetCookie === "function") return candidate.getSetCookie();
  const combined = headers.get("set-cookie");
  return combined ? splitSetCookieHeader(combined) : [];
}

class CookieJar {
  private readonly values = new Map<string, string>();

  absorb(headers: Headers): void {
    for (const header of setCookieHeaders(headers)) {
      const firstPair = header.split(";", 1)[0]?.trim();
      if (!firstPair) continue;
      const equalsIndex = firstPair.indexOf("=");
      if (equalsIndex <= 0) continue;
      const name = firstPair.slice(0, equalsIndex);
      const value = firstPair.slice(equalsIndex + 1);
      this.values.set(name, value);
    }
  }

  get(name: string): string {
    return this.values.get(name) ?? "";
  }

  headerValue(): string {
    return [...this.values.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 3000) };
  }
}

export class LcnClient {
  private readonly cookies = new CookieJar();
  private xsrfToken = "";

  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly options: ClientOptions,
  ) {}

  async login(): Promise<void> {
    const csrfResponse = await this.rawRequest("/sanctum/csrf-cookie", { method: "GET" });
    if (!csrfResponse.ok) {
      throw new LcnApiError(
        `CSRF request failed with status ${csrfResponse.status}`,
        csrfResponse.status,
        csrfResponse.body,
      );
    }
    this.updateCookies(csrfResponse.headers);

    const loginResponse = await this.rawRequest("/api/login", {
      method: "POST",
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    if (!loginResponse.ok) {
      throw new LcnApiError(
        `LCN login failed with status ${loginResponse.status}`,
        loginResponse.status,
        loginResponse.body,
      );
    }
    this.updateCookies(loginResponse.headers);
  }

  async getSchedules(
    config: BookingConfig,
    startDate: string,
    endDateExclusive: string,
  ): Promise<Schedule[]> {
    const url = new URL(
      `/api/schedules/between-dates/${encodeURIComponent(String(config.headquarterId))}/${encodeURIComponent(String(config.languageId))}/${startDate}/${endDateExclusive}`,
      API_BASE_URL,
    );
    url.searchParams.set("teachers", "[]");

    const response = await this.rawRequest(url.pathname + url.search, { method: "GET" });
    if (!response.ok) {
      throw new LcnApiError(
        `Schedule board failed with status ${response.status}`,
        response.status,
        response.body,
      );
    }

    const data = response.body && typeof response.body === "object" && "data" in response.body
      ? (response.body as { data?: unknown }).data
      : undefined;
    if (!Array.isArray(data)) {
      throw new LcnApiError("Schedule board returned an invalid data array", response.status, response.body);
    }
    return data as Schedule[];
  }

  async bookSchedule(schedule: Schedule, config: BookingConfig): Promise<LcnResponse> {
    const payload: JsonObject = {
      ...schedule,
      third_party_id: config.thirdPartyId,
      enrollment_id: config.enrollmentId,
    };

    return this.rawRequest(`/api/schedules/store-class-schedule/${config.bookingHoursRange}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  private async rawRequest(path: string, init: RequestInit): Promise<LcnResponse & { headers: Headers }> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${API_BASE_URL}${path}`,
        {
          ...init,
          headers: this.headers(),
        },
        this.options.timeoutMs,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LcnApiError(`LCN request failed: ${message}`);
    }

    return {
      ok: response.ok,
      status: response.status,
      body: await responseBody(response),
      headers: response.headers,
    };
  }

  private updateCookies(headers: Headers): void {
    this.cookies.absorb(headers);
    const rawXsrf = this.cookies.get("XSRF-TOKEN");
    if (rawXsrf) {
      try {
        this.xsrfToken = decodeURIComponent(rawXsrf);
      } catch {
        this.xsrfToken = rawXsrf;
      }
    }
  }

  private headers(): HeadersInit {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: this.cookies.headerValue(),
      "X-XSRF-TOKEN": this.xsrfToken,
      "X-Requested-With": "XMLHttpRequest",
      Origin: WEB_ORIGIN,
      Referer: `${WEB_ORIGIN}/`,
    };
  }
}
