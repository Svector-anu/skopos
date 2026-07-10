// Eager import of every agentcash-paid route so the router's registry is
// populated on cold start, before anyone hits the route directly — required
// for /openapi.json and /llms.txt to list routes nobody has called yet.
// Add each new paid route file here as it's created.
import "@/app/api/price/route";
