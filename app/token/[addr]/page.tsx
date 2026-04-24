import { redirect } from "next/navigation";

export default async function TokenPage({
  params,
}: {
  params: Promise<{ addr: string }>;
}) {
  const { addr } = await params;
  redirect(`/app?q=${encodeURIComponent(`analyze token ${addr}`)}`);
}

