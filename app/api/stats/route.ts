import { getA2aServed } from "@/lib/usage";

export const dynamic = "force-dynamic";

// Public KPI read. Deliberately generic naming — the agent-to-agent oracle is
// branded "a2a" on every outward surface, never by the underlying network.
export async function GET(): Promise<Response> {
  const total = await getA2aServed();
  return Response.json({ a2aCallsServed: total ?? 0 });
}
