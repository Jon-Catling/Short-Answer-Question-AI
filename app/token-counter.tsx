"use client";
import { useCallback, useEffect, useState } from "react";
type Usage = { totalTokens?: number };
const email = () => sessionStorage.getItem("ai-teaching-tools-email")?.trim().toLowerCase() ?? "";
const pence = (tokens: number) => ((tokens / 1_000_000) * 60).toFixed(2);
export function TokenCounter() {
  const [total, setTotal] = useState<number | null>(null); const [resetting, setResetting] = useState(false);
  const refresh = useCallback(async () => { const user = email(); if (!user) return; try { const response = await fetch(`/api/token-usage?email=${encodeURIComponent(user)}`, { cache: "no-store", headers: { "x-user-email": user } }); const data = await response.json() as Usage; if (response.ok && typeof data.totalTokens === "number") setTotal(data.totalTokens); } catch { setTotal(null); } }, []);
  useEffect(() => { void refresh(); window.addEventListener("cumulative-cost-updated", refresh); return () => window.removeEventListener("cumulative-cost-updated", refresh); }, [refresh]);
  async function reset() { const user = email(); if (!user || resetting) return; setResetting(true); try { const response = await fetch("/api/token-usage", { method:"POST", headers:{"content-type":"application/json", "x-user-email": user}, body:JSON.stringify({action:"reset", email:user}) }); const data = await response.json() as Usage; if (response.ok) setTotal(data.totalTokens ?? 0); } catch { /* keep the existing total when the shared service is unavailable */ } finally { setResetting(false); } }
  return <div className="token-controls"><span className="token-counter" aria-live="polite">Cumulative API cost: <strong>{total === null ? "—" : `${pence(total)}p`}</strong></span><button type="button" className="reset-tokens" onClick={reset} disabled={resetting}>{resetting ? "Resetting…" : "Reset counter"}</button></div>;
}
export function currentUserEmail() { return email(); }
export async function recordTokenUsage(user: string, tokens: number) { void user; void tokens; window.dispatchEvent(new Event("cumulative-cost-updated")); }
