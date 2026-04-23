import { redirect } from "next/navigation";

export default async function AddressPage({
  params,
}: {
  params: Promise<{ addr: string }>;
}) {
  const { addr } = await params;
  redirect(`/app?q=${encodeURIComponent(`analyze wallet ${addr}`)}`);
}
