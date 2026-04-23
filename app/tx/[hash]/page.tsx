import { redirect } from "next/navigation";

export default async function TxPage({
  params,
}: {
  params: Promise<{ hash: string }>;
}) {
  const { hash } = await params;
  redirect(`/app?q=${encodeURIComponent(`lookup transaction ${hash}`)}`);
}
