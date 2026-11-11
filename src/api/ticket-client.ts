import { getAuthToken, refreshAuthToken } from "../relay/relay-auth.js";
import { settingsStore } from "../store/settings-store.js";

function getApiBaseUrl(): string {
  const relayUrl = settingsStore.getState().config.relay.relayUrl;
  return relayUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

async function apiRequest(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  let token = getAuthToken();
  if (!token) throw new Error("Not logged in. Run `flaio login` first.");

  const url = `${getApiBaseUrl()}${path}`;
  const headers = {
    ...options.headers,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  let res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    token = await refreshAuthToken();
    if (!token) throw new Error("Session expired. Run `flaio login` again.");
    res = await fetch(url, {
      ...options,
      headers: { ...headers, Authorization: `Bearer ${token}` },
    });
  }

  return res;
}

export interface ListTicketsOptions {
  column?: string;
  search?: string;
  limit?: number;
}

export async function listTickets(opts: ListTicketsOptions = {}) {
  const params = new URLSearchParams();
  if (opts.column) params.set("column", opts.column);
  if (opts.search) params.set("search", opts.search);
  if (opts.limit) params.set("limit", String(opts.limit));

  const qs = params.toString();
  const res = await apiRequest(`/api/tickets${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Failed to list tickets: ${res.statusText}`);
  return (await res.json()) as { tickets: Record<string, unknown>[] };
}

export async function getTicket(ticketId: string) {
  const res = await apiRequest(`/api/tickets/${encodeURIComponent(ticketId)}`);
  if (!res.ok) throw new Error(`Failed to get ticket: ${res.statusText}`);
  return (await res.json()) as { ticket: Record<string, unknown> };
}

export async function updateTicket(
  ticketId: string,
  updates: Record<string, unknown>,
) {
  const res = await apiRequest(
    `/api/tickets/${encodeURIComponent(ticketId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(updates),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      `Failed to update ticket: ${body.error || res.statusText}`,
    );
  }
  return (await res.json()) as { ticket: Record<string, unknown> };
}
